<?php

use App\Contracts\AdminNotifier;
use App\Models\Task;
use App\Models\TaskList;
use App\Models\User;
use Database\Seeders\DemoSeeder;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Facades\Storage;
use Tests\Support\RecordingNotifier;

beforeEach(function () {
    config(['slax.demo.reset_enabled' => true]);
    $this->seed(DemoSeeder::class);
    expect((int) config('database.redis.default.database'))->toBe(15);
    Redis::connection()->flushdb();
    Storage::fake('s3');
    $this->notifier = new RecordingNotifier;
    app()->instance(AdminNotifier::class, $this->notifier);
    fakeTerminations();
});

/** @return array<int, int|null> task id => list id, for the given ids, as the database says. */
function placed(array $ids): array
{
    return Task::whereKey($ids)->pluck('list_id', 'id')->all();
}

test('the reset deletes tasks and lists of demo accounts, including surviving ones', function () {
    $survivor = User::factory()->demo()->create();
    $expired = User::factory()->demo(daysAgo: 30)->create();
    $member = User::factory()->create();

    $survivorList = TaskList::factory()->create(['user_id' => $survivor->id]);
    $expiredList = TaskList::factory()->create(['user_id' => $expired->id]);
    $memberList = TaskList::factory()->create(['user_id' => $member->id]);

    $own = Task::factory()->create(['creator_id' => $survivor->id, 'list_id' => $survivorList->id]);
    $ownExpired = Task::factory()->create(['creator_id' => $expired->id, 'list_id' => $expiredList->id]);
    // Created by a demo account for a member: visitor content, it goes too.
    $forMember = Task::factory()->create(['creator_id' => $survivor->id, 'assignee_id' => $member->id, 'list_id' => $memberList->id]);
    $forSeed = Task::factory()->create(['creator_id' => $expired->id, 'assignee_id' => User::where('google_sub', DemoSeeder::SUB_PREFIX.'sam')->value('id')]);
    // A member's own, untouched.
    $mine = Task::factory()->create(['creator_id' => $member->id, 'list_id' => $memberList->id]);

    $this->artisan('slax:demo-reset')->assertSuccessful();

    expect(Task::whereKey([$own->id, $ownExpired->id, $forMember->id, $forSeed->id])->count())->toBe(0)
        ->and(TaskList::whereKey([$survivorList->id, $expiredList->id])->count())->toBe(0)
        // The survivor stays, without lists; the member's list and task are not demo content.
        ->and(User::find($survivor->id))->not->toBeNull()
        ->and(TaskList::find($memberList->id))->not->toBeNull()
        ->and(Task::find($mine->id))->list_id->toBe($memberList->id);
});

test('a member\'s or a seed\'s task that sat in a demo list returns to its author\'s inbox', function () {
    $member = User::factory()->create();
    $survivor = User::factory()->demo()->create();
    $expired = User::factory()->demo(daysAgo: 30)->create();
    $survivorList = TaskList::factory()->create(['user_id' => $survivor->id]);
    $expiredList = TaskList::factory()->create(['user_id' => $expired->id]);

    $toSurvivor = Task::factory()->create(['creator_id' => $member->id, 'assignee_id' => $survivor->id, 'list_id' => $survivorList->id]);
    $toExpired = Task::factory()->create(['creator_id' => $member->id, 'assignee_id' => $expired->id, 'list_id' => $expiredList->id]);

    $seed = User::where('google_sub', DemoSeeder::SUB_PREFIX.'noa')->sole();
    $fromSeed = Task::factory()->public()->create(['creator_id' => $seed->id, 'assignee_id' => $survivor->id, 'list_id' => $survivorList->id]);
    // Already unfiled with the surviving account: not in a demo list, it stays where it is.
    $unfiled = Task::factory()->create(['creator_id' => $member->id, 'assignee_id' => $survivor->id]);

    $this->artisan('slax:demo-reset')->assertSuccessful();

    // Spec §10: out of the deleted demo list, back to its author, in their inbox, whether the demo account survives or not.
    expect(User::find($survivor->id))->not->toBeNull()
        ->and($toSurvivor->fresh())->list_id->toBeNull()->assignee_id->toBe($member->id)->creator_id->toBe($member->id)
        ->and($toExpired->fresh())->list_id->toBeNull()->assignee_id->toBe($member->id)->creator_id->toBe($member->id)
        ->and($fromSeed->fresh())->list_id->toBeNull()->assignee_id->toBe($seed->id)
        ->and($unfiled->fresh())->list_id->toBeNull()->assignee_id->toBe($survivor->id);
});

test('a task a member gave a deleted demo account returns to the member, one given to a surviving demo account stays', function () {
    $member = User::factory()->create();
    $seed = User::where('google_sub', DemoSeeder::SUB_PREFIX.'noa')->sole();
    $survivor = User::factory()->demo()->create();
    $expired = User::factory()->demo(daysAgo: 30)->create();

    $inExpiredInbox = Task::factory()->create(['creator_id' => $member->id, 'assignee_id' => $expired->id]);
    $fromSeed = Task::factory()->public()->create(['creator_id' => $seed->id, 'assignee_id' => $expired->id]);
    $inSurvivorInbox = Task::factory()->create(['creator_id' => $member->id, 'assignee_id' => $survivor->id]);

    $this->artisan('slax:demo-reset')->assertSuccessful();

    expect(User::find($expired->id))->toBeNull()
        ->and($inExpiredInbox->fresh())->assignee_id->toBe($member->id)->list_id->toBeNull()
        ->and($fromSeed->fresh())->assignee_id->toBe($seed->id)->visibility->toBe(Task::PUBLIC)
        ->and($inSurvivorInbox->fresh())->assignee_id->toBe($survivor->id)->creator_id->toBe($member->id);
});

test('a banned demo account is kept by the reset, so are the tasks a member gave it', function () {
    $member = User::factory()->create();
    $banned = User::factory()->demo(daysAgo: 30)->banned()->create();
    $given = Task::factory()->create(['creator_id' => $member->id, 'assignee_id' => $banned->id]);
    $theirs = Task::factory()->create(['creator_id' => $banned->id]);

    $this->artisan('slax:demo-reset')->assertSuccessful();

    expect(User::find($banned->id))->not->toBeNull()
        ->and($given->fresh())->assignee_id->toBe($banned->id)
        ->and(Task::find($theirs->id))->toBeNull();
});

test('seed tasks are restored without duplicates when the seeder or the reset runs twice', function () {
    expect(TaskList::count())->toBe(count(DemoSeeder::TASK_LISTS))
        ->and(Task::count())->toBe(count(DemoSeeder::TASKS));

    $people = User::where('account_type', User::ACCOUNT_SEED)->get()->keyBy(fn (User $user) => str_replace(DemoSeeder::SUB_PREFIX, '', $user->google_sub));

    // Public and private ones, and at least one handed from a seed person to another, in the inbox.
    expect(collect(DemoSeeder::TASKS)->pluck('visibility')->unique()->sort()->values()->all())->toBe(['private', 'public']);
    $handed = collect(DemoSeeder::TASKS)->filter(fn (array $seed) => isset($seed['to']) && $seed['to'] !== $seed['by'])->values();
    expect($handed)->not->toBeEmpty();
    foreach ($handed as $seed) {
        $task = Task::where('creator_id', $people[$seed['by']]->id)->where('title', $seed['title'])->sole();
        expect($task)->assignee_id->toBe($people[$seed['to']]->id)->list_id->toBeNull();
    }

    // A listed seed task sits in a list of its assignee.
    foreach (collect(DemoSeeder::TASKS)->filter(fn (array $seed) => isset($seed['list'])) as $seed) {
        $task = Task::where('creator_id', $people[$seed['by']]->id)->where('title', $seed['title'])->sole();
        expect($task->list)->user_id->toBe($task->assignee_id);
    }

    // Tampered with: completed, moved to another person, then a deleted one.
    $victim = Task::where('title', DemoSeeder::TASKS[0]['title'])->sole();
    $victim->forceFill(['completed_at' => now(), 'visibility' => $victim->visibility === 'public' ? 'private' : 'public'])->save();
    Task::where('title', DemoSeeder::TASKS[1]['title'])->delete();

    $snapshot = fn () => [
        'lists' => TaskList::orderBy('id')->get(['user_id', 'name', 'position'])->toArray(),
        'tasks' => Task::orderBy('creator_id')->orderBy('title')->get(['creator_id', 'assignee_id', 'list_id', 'title', 'visibility', 'completed_at', 'position'])->toArray(),
    ];

    (new DemoSeeder)->run();
    $afterSeeder = $snapshot();
    expect(TaskList::count())->toBe(count(DemoSeeder::TASK_LISTS))
        ->and(Task::count())->toBe(count(DemoSeeder::TASKS))
        ->and($victim->fresh()->completed_at)->toBeNull();

    $this->artisan('slax:demo-reset')->assertSuccessful();
    $this->artisan('slax:demo-reset')->assertSuccessful();
    (new DemoSeeder)->run();

    expect(TaskList::count())->toBe(count(DemoSeeder::TASK_LISTS))
        ->and(Task::count())->toBe(count(DemoSeeder::TASKS))
        ->and(collect($snapshot()['tasks'])->pluck('title')->all())->toBe(collect($afterSeeder['tasks'])->pluck('title')->all());
});

test('the summary reports deleted_tasks and deleted_task_lists', function () {
    $survivor = User::factory()->demo()->create();
    $expired = User::factory()->demo(daysAgo: 30)->create();
    $member = User::factory()->create();
    $listA = TaskList::factory()->create(['user_id' => $survivor->id]);
    $listB = TaskList::factory()->create(['user_id' => $expired->id]);
    Task::factory()->count(2)->create(['creator_id' => $survivor->id, 'list_id' => $listA->id]);
    Task::factory()->create(['creator_id' => $expired->id, 'assignee_id' => $member->id]);
    // Not counted: a member's task that only changes place.
    Task::factory()->create(['creator_id' => $member->id, 'assignee_id' => $expired->id, 'list_id' => $listB->id]);

    $this->artisan('slax:demo-reset')->assertSuccessful();

    $summary = $this->notifier->withTitle('Demo reset');
    expect($summary)->toHaveCount(1)
        ->and($summary[0]['context'])->toMatchArray(['deleted_tasks' => 3, 'deleted_task_lists' => 2, 'deleted_users' => 1]);
});
