<?php

use App\Models\Task;
use App\Models\TaskList;
use App\Models\User;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

test("a colleague's page shows public tasks, plus private ones I created for them, grouped by list, with unfiled ones apart", function () {
    [$me, $colleague, $other] = User::factory()->count(3)->create();
    $second = TaskList::factory()->create(['user_id' => $colleague->id, 'name' => 'Second', 'position' => 1]);
    $first = TaskList::factory()->create(['user_id' => $colleague->id, 'name' => 'First', 'position' => 0]);

    $publicLate = Task::factory()->public()->create(['creator_id' => $colleague->id, 'list_id' => $first->id, 'position' => 2]);
    $publicEarly = Task::factory()->public()->create(['creator_id' => $other->id, 'assignee_id' => $colleague->id, 'list_id' => $first->id, 'position' => 1]);
    $givenByMe = Task::factory()->private()->create(['creator_id' => $me->id, 'assignee_id' => $colleague->id, 'list_id' => $second->id]);
    $unfiled = Task::factory()->public()->completed()->create(['creator_id' => $colleague->id]);
    // Hidden from me: their own private one, and one somebody else gave them privately.
    $hiddenInList = Task::factory()->private()->create(['creator_id' => $colleague->id, 'list_id' => $first->id, 'position' => 3]);
    $hiddenUnfiled = Task::factory()->private()->create(['creator_id' => $other->id, 'assignee_id' => $colleague->id]);
    // Not theirs: I hold it, they created it (it shows on my own page only).
    $heldByMe = Task::factory()->public()->create(['creator_id' => $colleague->id, 'assignee_id' => $me->id]);

    $json = asUser($me)->getJson("/api/v1/users/{$colleague->id}/tasks")->assertOk()
        ->assertJsonPath('user', ['id' => $colleague->id, 'name' => $colleague->name, 'avatar_url' => $colleague->avatar_url])
        ->assertJsonCount(2, 'lists')
        ->json();

    expect(array_keys($json))->toBe(['user', 'lists', 'unfiled'])
        ->and(collect($json['lists'])->pluck('id')->all())->toBe([$first->id, $second->id])
        ->and(collect($json['lists'])->pluck('name')->all())->toBe(['First', 'Second'])
        ->and(collect($json['lists'][0]['tasks'])->pluck('id')->all())->toBe([$publicEarly->id, $publicLate->id])
        ->and(collect($json['lists'][1]['tasks'])->pluck('id')->all())->toBe([$givenByMe->id])
        ->and(collect($json['unfiled'])->pluck('id')->all())->toBe([$unfiled->id])
        ->and($json['unfiled'][0])->toMatchArray(['completed' => true, 'visibility' => 'public'])
        ->and($json['lists'][1]['tasks'][0])->toMatchArray(['visibility' => 'private', 'creator' => ['id' => $me->id, 'name' => $me->name, 'avatar_url' => $me->avatar_url]]);
    expect(json_encode($json))->not->toContain($hiddenInList->title)->not->toContain($hiddenUnfiled->title);

    // My own page shows everything of mine.
    $mine = Task::factory()->private()->create(['creator_id' => $me->id]);
    asUser($me)->getJson("/api/v1/users/{$me->id}/tasks")->assertOk()
        ->assertJsonPath('user.id', $me->id)
        ->assertJsonPath('unfiled.0.id', $heldByMe->id)
        ->assertJsonPath('unfiled.1.id', $mine->id)
        ->assertJsonCount(2, 'unfiled');
});

test('a list holding only private tasks is absent from a colleague\'s page, name included', function () {
    [$me, $colleague] = User::factory()->count(2)->create();
    $secret = TaskList::factory()->create(['user_id' => $colleague->id, 'name' => 'Surprise party for Dana']);
    $empty = TaskList::factory()->create(['user_id' => $colleague->id, 'name' => 'Nothing in here']);
    $shown = TaskList::factory()->create(['user_id' => $colleague->id, 'name' => 'Visible list']);
    Task::factory()->private()->create(['creator_id' => $colleague->id, 'list_id' => $secret->id]);
    Task::factory()->public()->create(['creator_id' => $colleague->id, 'list_id' => $shown->id]);

    $response = asUser($me)->getJson("/api/v1/users/{$colleague->id}/tasks")->assertOk()
        ->assertJsonCount(1, 'lists')
        ->assertJsonPath('lists.0.id', $shown->id);
    expect($response->getContent())->not->toContain('Surprise party')->not->toContain($empty->name);

    // The owner sees every list that holds a task of theirs (and still not an empty one).
    asUser($colleague)->getJson("/api/v1/users/{$colleague->id}/tasks")->assertOk()
        ->assertJsonCount(2, 'lists')->assertJsonPath('lists.0.name', 'Surprise party for Dana');
});

test('a stranger never sees a private task through any endpoint (lists, inbox, by-me, user page)', function () {
    [$creator, $assignee, $stranger] = User::factory()->count(3)->create();
    $list = TaskList::factory()->create(['user_id' => $assignee->id]);
    $title = 'Quarterly layoffs plan zx9';
    Task::factory()->private()->create(['title' => $title, 'creator_id' => $creator->id, 'assignee_id' => $assignee->id, 'list_id' => $list->id]);
    Task::factory()->private()->create(['title' => $title.' inbox', 'creator_id' => $creator->id, 'assignee_id' => $assignee->id]);
    Task::factory()->private()->create(['title' => $title.' own', 'creator_id' => $assignee->id]);

    // The people involved do see them (so the loop below is not vacuous).
    expect(asUser($assignee)->getJson("/api/v1/task-lists/{$list->id}/tasks")->assertOk()->getContent())->toContain($title);
    expect(asUser($assignee)->getJson('/api/v1/tasks/inbox')->assertOk()->getContent())->toContain($title);
    expect(asUser($creator)->getJson('/api/v1/tasks/by-me')->assertOk()->getContent())->toContain($title);
    expect(asUser($creator)->getJson("/api/v1/users/{$assignee->id}/tasks")->assertOk()->getContent())->toContain($title);

    // The stranger sees the title nowhere, on any of the four.
    foreach ([
        "/api/v1/task-lists/{$list->id}/tasks" => 404,
        '/api/v1/tasks/inbox' => 200,
        '/api/v1/tasks/by-me' => 200,
        "/api/v1/users/{$assignee->id}/tasks" => 200,
        "/api/v1/users/{$creator->id}/tasks" => 200,
    ] as $url => $status) {
        $response = asUser($stranger)->getJson($url)->assertStatus($status);
        expect($response->getContent())->not->toContain('zx9', "leak through {$url}");
    }
    asUser($stranger)->getJson("/api/v1/users/{$assignee->id}/tasks")->assertJson(['lists' => [], 'unfiled' => []]);
});

test('after a public task is made private it disappears from the colleague\'s page on the next fetch', function () {
    [$me, $colleague] = User::factory()->count(2)->create();
    $list = TaskList::factory()->create(['user_id' => $colleague->id, 'name' => 'Errands']);
    $task = Task::factory()->public()->create(['creator_id' => $colleague->id, 'list_id' => $list->id]);

    asUser($me)->getJson("/api/v1/users/{$colleague->id}/tasks")->assertOk()
        ->assertJsonPath('lists.0.tasks.0.id', $task->id);

    asUser($colleague)->patchJson("/api/v1/tasks/{$task->id}", ['visibility' => 'private'])->assertOk();

    $response = asUser($me)->getJson("/api/v1/users/{$colleague->id}/tasks")->assertOk()
        ->assertExactJson(['user' => ['id' => $colleague->id, 'name' => $colleague->name, 'avatar_url' => $colleague->avatar_url], 'lists' => [], 'unfiled' => []]);
    expect($response->getContent())->not->toContain($task->title)->not->toContain('Errands');
});

test('inbox and by-me show the right tasks and nothing else, completed ones included', function () {
    [$me, $other, $third] = User::factory()->count(3)->create();
    $list = TaskList::factory()->create(['user_id' => $me->id]);

    $ownInbox = Task::factory()->create(['creator_id' => $me->id, 'position' => 1]);
    $givenInbox = Task::factory()->private()->create(['creator_id' => $other->id, 'assignee_id' => $me->id, 'position' => 0]);
    $doneInbox = Task::factory()->completed()->create(['creator_id' => $other->id, 'assignee_id' => $me->id, 'position' => 1]);
    Task::factory()->public()->create(['creator_id' => $other->id, 'assignee_id' => $third->id]);

    $byMe = Task::factory()->private()->create(['creator_id' => $me->id, 'assignee_id' => $other->id, 'position' => 1]);
    $byMeDone = Task::factory()->public()->completed()->create(['creator_id' => $me->id, 'assignee_id' => $third->id, 'position' => 0]);
    Task::factory()->create(['creator_id' => $me->id, 'assignee_id' => $me->id, 'list_id' => $list->id]);
    Task::factory()->public()->create(['creator_id' => $other->id, 'assignee_id' => $me->id, 'list_id' => $list->id]);

    // Ordered by position, then id; the completed one is flagged, not left out.
    $inbox = asUser($me)->getJson('/api/v1/tasks/inbox')->assertOk()->json();
    expect(collect($inbox)->pluck('id')->all())->toBe([$givenInbox->id, $ownInbox->id, $doneInbox->id])
        ->and(collect($inbox)->pluck('completed')->all())->toBe([false, false, true])
        ->and($inbox[0])->toHaveKeys(['id', 'title', 'visibility', 'completed', 'completed_at', 'list_id', 'position', 'creator', 'assignee', 'created_at'])
        ->and($inbox[0]['creator']['id'])->toBe($other->id);

    $mine = asUser($me)->getJson('/api/v1/tasks/by-me')->assertOk()->json();
    expect(collect($mine)->pluck('id')->all())->toBe([$byMeDone->id, $byMe->id])
        ->and(collect($mine)->pluck('assignee.id')->all())->toBe([$third->id, $other->id])
        ->and($mine[0]['completed'])->toBeTrue();

    // The tasks of one of my lists.
    $filed = collect(asUser($me)->getJson("/api/v1/task-lists/{$list->id}/tasks")->assertOk()->json());
    expect($filed)->toHaveCount(2)->and($filed->pluck('list_id')->unique()->all())->toBe([$list->id]);
});

test('the inbox holds at most 200 tasks', function () {
    $me = User::factory()->create();
    Task::factory()->count(201)->create(['creator_id' => $me->id]);

    expect(asUser($me)->getJson('/api/v1/tasks/inbox')->assertOk()->json())->toHaveCount(200);
});

test("a banned colleague's page answers 404", function () {
    [$me, $colleague] = User::factory()->count(2)->create();
    Task::factory()->public()->create(['creator_id' => $colleague->id]);

    asUser($me)->getJson("/api/v1/users/{$colleague->id}/tasks")->assertOk();

    $colleague->forceFill(['banned_at' => now()])->save();
    asUser($me)->getJson("/api/v1/users/{$colleague->id}/tasks")->assertNotFound();

    // Unknown ids answer the same; a non-numeric one never reaches the controller.
    asUser($me)->getJson('/api/v1/users/999999/tasks')->assertNotFound();
    asUser($me)->getJson('/api/v1/users/abc/tasks')->assertNotFound();
});

test('someone else\'s list tasks answer 404', function () {
    [$me, $other] = User::factory()->count(2)->create();
    $theirs = TaskList::factory()->create(['user_id' => $other->id]);
    Task::factory()->public()->create(['creator_id' => $other->id, 'list_id' => $theirs->id]);

    asUser($me)->getJson("/api/v1/task-lists/{$theirs->id}/tasks")->assertNotFound();
    asUser($me)->getJson('/api/v1/task-lists/999999/tasks')->assertNotFound();
    asUser($other)->getJson("/api/v1/task-lists/{$theirs->id}/tasks")->assertOk()->assertJsonCount(1);
});

test('the read endpoints need a signed-in, non-banned caller', function () {
    $me = User::factory()->create();
    $list = TaskList::factory()->create(['user_id' => $me->id]);

    foreach (["/api/v1/task-lists/{$list->id}/tasks", '/api/v1/tasks/inbox', '/api/v1/tasks/by-me', "/api/v1/users/{$me->id}/tasks"] as $url) {
        $this->getJson($url)->assertUnauthorized();
    }

    $me->forceFill(['banned_at' => now()])->save();
    asUser($me)->getJson('/api/v1/tasks/inbox')->assertForbidden();
});

test('the number of queries does not grow with the number of tasks', function () {
    [$me, $colleague] = User::factory()->count(2)->create();
    $count = function () use ($me, $colleague): int {
        DB::flushQueryLog();
        DB::enableQueryLog();
        foreach (['/api/v1/tasks/inbox', '/api/v1/tasks/by-me', "/api/v1/users/{$colleague->id}/tasks"] as $url) {
            asUser($me)->getJson($url)->assertOk();
        }
        $n = count(DB::getQueryLog());
        DB::disableQueryLog();

        return $n;
    };
    $seed = function (int $n) use ($me, $colleague): void {
        foreach (range(1, $n) as $i) {
            $other = User::factory()->create();
            $list = TaskList::factory()->create(['user_id' => $colleague->id]);
            Task::factory()->public()->create(['creator_id' => $other->id, 'assignee_id' => $me->id]);
            Task::factory()->public()->create(['creator_id' => $me->id, 'assignee_id' => $other->id]);
            Task::factory()->public()->create(['creator_id' => $other->id, 'assignee_id' => $colleague->id, 'list_id' => $list->id]);
            Task::factory()->public()->create(['creator_id' => $colleague->id]);
        }
    };

    $seed(1);
    $few = $count();
    $seed(8);
    $many = $count();

    expect($many)->toBe($few);
});
