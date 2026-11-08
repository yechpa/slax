<?php

use App\Jobs\SendPushNotification;
use App\Models\Task;
use App\Models\User;
use App\Services\PresenceService;
use App\Services\Push\PushPayload;
use App\Services\Push\WebPushSender;
use App\Services\TaskService;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Exceptions;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Redis;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
    // phpunit.xml points Redis at database 15 (presence lives there); never flush anything else.
    expect((int) config('database.redis.default.database'))->toBe(15);
    Redis::connection()->flushdb();
    enablePush();
});

/** @return Collection<int, SendPushNotification> */
function taskPushes(): Collection
{
    return Queue::pushed(SendPushNotification::class)->sortBy('subscriptionId')->values();
}

test('assigning to an away colleague queues one push per device with type task, url /tasks/inbox, in the device\'s language', function () {
    Queue::fake();
    $alice = User::factory()->create(['name' => 'Alice Martin']);
    $bob = User::factory()->create();
    $phone = device($bob, 'fr');
    $laptop = device($bob, 'he');
    $tablet = device($bob, 'en');
    device($alice);
    app(PresenceService::class)->heartbeat($bob->id, false);
    expect(app(PresenceService::class)->stateOf($bob->id))->toBe('away');

    asUser($alice)->postJson('/api/v1/tasks', ['title' => 'Review', 'visibility' => 'private', 'assignee_id' => $bob->id])->assertCreated();

    $jobs = taskPushes();
    expect($jobs->pluck('subscriptionId')->all())->toBe([$phone->id, $laptop->id, $tablet->id])
        ->and($jobs->every(fn (SendPushNotification $job) => $job->queue === 'push' && $job->channelId === null && $job->messageId === null))->toBeTrue()
        ->and($jobs[0]->payload)->toBe([
            'type' => 'task',
            'title' => "Alice Martin t'a assigné une tâche",
            'body' => 'Nouvelle tâche',
            'url' => '/tasks/inbox',
            'tag' => 'tasks',
        ])
        ->and($jobs[1]->payload)->toBe([
            'type' => 'task',
            'title' => 'Alice Martin הקצה לך משימה',
            'body' => 'משימה חדשה',
            'url' => '/tasks/inbox',
            'tag' => 'tasks',
        ])
        ->and($jobs[2]->payload)->toBe([
            'type' => 'task',
            'title' => 'Alice Martin assigned you a task',
            'body' => 'New task',
            'url' => '/tasks/inbox',
            'tag' => 'tasks',
        ]);
});

test('a sender named by an e-mail address is shown as someone', function () {
    $payload = PushPayload::forTask(User::factory()->make(['name' => 'alice@example.test']), 'en');

    expect($payload['title'])->toBe('Someone assigned you a task')
        ->and(PushPayload::TYPE_TASK)->toBe('task');
});

test('the payload contains no title of the task', function () {
    Queue::fake();
    [$alice, $bob] = User::factory()->count(2)->create();
    device($bob, 'en');
    device($bob, 'fr');
    device($bob, 'he');
    $marker = 'ZX-Q7-secret-title-'.bin2hex(random_bytes(4));

    asUser($alice)->postJson('/api/v1/tasks', ['title' => $marker, 'visibility' => 'public', 'assignee_id' => $bob->id])->assertCreated();

    $jobs = taskPushes();
    expect($jobs)->toHaveCount(3);
    foreach ($jobs as $job) {
        expect(array_keys($job->payload))->toBe(['type', 'title', 'body', 'url', 'tag']);
        foreach ($job->payload as $value) {
            expect($value)->not->toContain($marker);
        }
    }
});

test('nothing for self-assignment, for an online colleague, for a banned one', function () {
    Queue::fake();
    [$alice, $online, $banned] = User::factory()->count(3)->create();
    device($alice);
    device($online);
    device($banned);
    app(PresenceService::class)->heartbeat($online->id, true);
    expect(app(PresenceService::class)->stateOf($online->id))->toBe('online');

    // Self-assignment (explicit and by default).
    asUser($alice)->postJson('/api/v1/tasks', ['title' => 'Mine', 'visibility' => 'private', 'assignee_id' => $alice->id])->assertCreated();
    asUser($alice)->postJson('/api/v1/tasks', ['title' => 'Mine too', 'visibility' => 'private'])->assertCreated();
    // Online: sees it in the app.
    asUser($alice)->postJson('/api/v1/tasks', ['title' => 'For online', 'visibility' => 'private', 'assignee_id' => $online->id])->assertCreated();
    // Banned: refused (and never pushed).
    $banned->forceFill(['banned_at' => now()])->save();
    asUser($alice)->postJson('/api/v1/tasks', ['title' => 'For banned', 'visibility' => 'private', 'assignee_id' => $banned->id])->assertUnprocessable();

    Queue::assertNotPushed(SendPushNotification::class);
});

test('nothing when push is off', function () {
    Queue::fake();
    [$alice, $bob] = User::factory()->count(2)->create();
    device($bob);
    config(['slax.push.public_key' => '']);

    asUser($alice)->postJson('/api/v1/tasks', ['title' => 'Quiet', 'visibility' => 'private', 'assignee_id' => $bob->id])->assertCreated();

    Queue::assertNotPushed(SendPushNotification::class);
});

test('reassignment and return notify the new holder', function () {
    Queue::fake();
    [$alice, $bob, $carol] = User::factory()->count(3)->create();
    $bobs = device($bob);
    $carols = device($carol);
    $alices = device($alice);
    $task = Task::factory()->create(['creator_id' => $alice->id, 'assignee_id' => $bob->id]);

    // Reassignment: the new holder, not the former one nor the creator.
    asUser($alice)->patchJson("/api/v1/tasks/{$task->id}", ['assignee_id' => $carol->id])->assertOk();
    expect(taskPushes()->pluck('subscriptionId')->all())->toBe([$carols->id]);

    // Return: the creator.
    asUser($carol)->postJson("/api/v1/tasks/{$task->id}/return")->assertOk();
    expect(taskPushes()->pluck('subscriptionId')->all())->toBe([$carols->id, $alices->id])
        ->and(taskPushes()[1]->payload['type'])->toBe('task');

    // Editing the title only, or ticking: no push.
    asUser($alice)->patchJson("/api/v1/tasks/{$task->id}", ['title' => 'Renamed'])->assertOk();
    asUser($alice)->putJson("/api/v1/tasks/{$task->id}/completion", ['completed' => true])->assertOk();
    // Reassigning to oneself: no push.
    asUser($alice)->patchJson("/api/v1/tasks/{$task->id}", ['assignee_id' => $alice->id])->assertOk();

    expect(taskPushes())->toHaveCount(2)
        ->and($bobs->id)->not->toBeIn(taskPushes()->pluck('subscriptionId')->all());
});

test('a refused request queues nothing', function () {
    Queue::fake();
    [$alice, $bob] = User::factory()->count(2)->create();
    device($bob);
    Task::factory()->count(200)->unfiled()->create(['creator_id' => $alice->id, 'assignee_id' => $bob->id]);

    asUser($alice)->postJson('/api/v1/tasks', ['title' => 'One too many', 'visibility' => 'private', 'assignee_id' => $bob->id])
        ->assertUnprocessable()->assertJson(['error' => 'inbox_full']);

    Queue::assertNotPushed(SendPushNotification::class);
});

test('a rolled-back change queues nothing, and a committed one only once it is committed', function () {
    Queue::fake();
    [$alice, $bob] = User::factory()->count(2)->create();
    device($bob);

    try {
        DB::transaction(function () use ($alice, $bob) {
            app(TaskService::class)->createTask($alice, 'Rolled back', 'private', null, $bob->id);
            Queue::assertNotPushed(SendPushNotification::class); // not before the commit
            throw new RuntimeException('rollback');
        });
    } catch (RuntimeException) {
    }
    Queue::assertNotPushed(SendPushNotification::class);
    expect(Task::where('title', 'Rolled back')->exists())->toBeFalse();

    DB::transaction(fn () => app(TaskService::class)->createTask($alice, 'Committed', 'private', null, $bob->id));
    expect(taskPushes())->toHaveCount(1);
});

test('a push failure does not fail the request', function () {
    // The queue runs jobs inline in tests (sync): the sender's exception surfaces in the request.
    Exceptions::fake();
    app(WebPushSender::class)->throws = new RuntimeException('push service down');
    [$alice, $bob] = User::factory()->count(2)->create();
    device($bob);

    $id = asUser($alice)->postJson('/api/v1/tasks', ['title' => 'Still created', 'visibility' => 'private', 'assignee_id' => $bob->id])
        ->assertCreated()->json('id');

    expect(Task::whereKey($id)->exists())->toBeTrue();
    Exceptions::assertReported(RuntimeException::class);
});

test('the job treats a missing channel and message as no membership check, and still skips a banned person', function () {
    [$alice, $bob] = User::factory()->count(2)->create();
    $bobs = device($bob);
    $payload = PushPayload::forTask($alice, 'en');
    $sender = app(WebPushSender::class);

    (new SendPushNotification($bobs->id, null, null, $payload))->handle($sender);
    expect($sender->sent)->toHaveCount(1);

    $bob->forceFill(['banned_at' => now()])->save();
    (new SendPushNotification($bobs->id, null, null, $payload))->handle($sender);
    expect($sender->sent)->toHaveCount(1);
});
