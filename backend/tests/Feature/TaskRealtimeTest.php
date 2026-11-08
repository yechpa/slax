<?php

use App\Events\TaskChanged;
use App\Models\Task;
use App\Models\TaskList;
use App\Models\User;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
    Event::fake([TaskChanged::class]);
});

/** @return list<array{int, int}> [task id, user id] of every TaskChanged, in dispatch order */
function taskChanges(): array
{
    return Event::dispatched(TaskChanged::class)->map(fn ($call) => [$call[0]->taskId, $call[0]->userId])->values()->all();
}

/** @param  list<int>  $userIds */
function expectOneEachFor(int $taskId, array $userIds): void
{
    $changes = taskChanges();
    expect(array_column($changes, 0))->each->toBe($taskId)
        ->and(array_column($changes, 1))->toEqualCanonicalizing($userIds);
}

test('create for a colleague notifies creator and assignee once each', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();

    $id = asUser($creator)->postJson('/api/v1/tasks', ['title' => 'Review', 'visibility' => 'private', 'assignee_id' => $assignee->id])
        ->assertCreated()->json('id');

    expectOneEachFor($id, [$creator->id, $assignee->id]);
});

test('creating a task for oneself notifies oneself once', function () {
    $user = User::factory()->create();

    $id = asUser($user)->postJson('/api/v1/tasks', ['title' => 'Mine', 'visibility' => 'private'])->assertCreated()->json('id');

    expectOneEachFor($id, [$user->id]);
});

test('reassigning also notifies the former assignee', function () {
    [$creator, $former, $new] = User::factory()->count(3)->create();
    $task = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $former->id]);

    asUser($creator)->patchJson("/api/v1/tasks/{$task->id}", ['assignee_id' => $new->id])->assertOk();

    expectOneEachFor($task->id, [$creator->id, $former->id, $new->id]);
});

test('editing the title without reassigning notifies creator and assignee only', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();
    $task = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    asUser($creator)->patchJson("/api/v1/tasks/{$task->id}", ['title' => 'Renamed'])->assertOk();

    expectOneEachFor($task->id, [$creator->id, $assignee->id]);
});

test('completing and reopening notify both', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();
    $task = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    asUser($assignee)->putJson("/api/v1/tasks/{$task->id}/completion", ['completed' => true])->assertOk();
    expectOneEachFor($task->id, [$creator->id, $assignee->id]);

    Event::fake([TaskChanged::class]);
    asUser($assignee)->putJson("/api/v1/tasks/{$task->id}/completion", ['completed' => false])->assertOk();
    expectOneEachFor($task->id, [$creator->id, $assignee->id]);
});

test('moving a task between lists notifies both, but moving it where it already is notifies nobody', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();
    $list = TaskList::factory()->create(['user_id' => $assignee->id]);
    $task = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    asUser($assignee)->postJson("/api/v1/tasks/{$task->id}/move", ['list_id' => $list->id])->assertOk();
    expectOneEachFor($task->id, [$creator->id, $assignee->id]);

    Event::fake([TaskChanged::class]);
    asUser($assignee)->postJson("/api/v1/tasks/{$task->id}/move", ['list_id' => $list->id])->assertOk();
    Event::assertNotDispatched(TaskChanged::class);
});

test('returning a task to its author notifies the author and the one who returned it', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();
    $task = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    asUser($assignee)->postJson("/api/v1/tasks/{$task->id}/return")->assertOk();

    expectOneEachFor($task->id, [$creator->id, $assignee->id]);
});

test('deleting a task notifies both', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();
    $task = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    asUser($creator)->deleteJson("/api/v1/tasks/{$task->id}")->assertNoContent();

    expect(Task::find($task->id))->toBeNull();
    expectOneEachFor($task->id, [$creator->id, $assignee->id]);
});

test('deleting a list notifies the owner and the authors of the tasks it sends back, once each', function () {
    [$owner, $alice, $bob] = User::factory()->count(3)->create();
    $list = TaskList::factory()->create(['user_id' => $owner->id]);
    $own = Task::factory()->create(['creator_id' => $owner->id, 'list_id' => $list->id]);
    $fromAlice = Task::factory()->create(['creator_id' => $alice->id, 'assignee_id' => $owner->id, 'list_id' => $list->id]);
    $fromAlice2 = Task::factory()->create(['creator_id' => $alice->id, 'assignee_id' => $owner->id, 'list_id' => $list->id]);
    $fromBob = Task::factory()->create(['creator_id' => $bob->id, 'assignee_id' => $owner->id, 'list_id' => $list->id]);
    $elsewhere = Task::factory()->create(['creator_id' => $alice->id, 'assignee_id' => $owner->id]);

    asUser($owner)->deleteJson("/api/v1/task-lists/{$list->id}")->assertNoContent();

    $parties = [
        $own->id => [$owner->id],
        $fromAlice->id => [$alice->id, $owner->id],
        $fromAlice2->id => [$alice->id, $owner->id],
        $fromBob->id => [$bob->id, $owner->id],
    ];
    $changes = taskChanges();
    expect(array_column($changes, 1))->toEqualCanonicalizing([$owner->id, $alice->id, $bob->id]);
    // Each person is told about one task that concerns them, and never about a task of another list.
    foreach ($changes as [$taskId, $userId]) {
        expect($parties)->toHaveKey($taskId)
            ->and($parties[$taskId])->toContain($userId);
    }
    expect(Task::whereKey($elsewhere->id)->exists())->toBeTrue();
});

test('deleting an empty list notifies nobody', function () {
    $owner = User::factory()->create();
    $list = TaskList::factory()->create(['user_id' => $owner->id]);

    asUser($owner)->deleteJson("/api/v1/task-lists/{$list->id}")->assertNoContent();

    Event::assertNotDispatched(TaskChanged::class);
});

test('the payload is exactly {task_id} and the channel is the user\'s own private channel', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();

    $id = asUser($creator)->postJson('/api/v1/tasks', ['title' => 'Secret plan', 'visibility' => 'private', 'assignee_id' => $assignee->id])
        ->assertCreated()->json('id');

    Event::dispatched(TaskChanged::class)->each(function ($call) use ($id) {
        $event = $call[0];
        expect(array_map(fn ($channel) => $channel->name, $event->broadcastOn()))->toBe(["private-App.Models.User.{$event->userId}"])
            ->and($event->broadcastAs())->toBe('task.changed')
            ->and($event->broadcastWith())->toBe(['task_id' => $id])
            ->and(json_encode($event->broadcastWith()))->not->toContain('Secret plan')->not->toContain('private');
    });
    expect(Event::dispatched(TaskChanged::class))->toHaveCount(2);
});

test('no event for a rejected request', function () {
    [$creator, $assignee, $stranger, $banned] = User::factory()->count(4)->create();
    $banned->forceFill(['banned_at' => now()])->save();
    $theirs = TaskList::factory()->create(['user_id' => $stranger->id]);
    $task = Task::factory()->private()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    // Refused by a rule.
    asUser($creator)->postJson('/api/v1/tasks', ['title' => 'x', 'visibility' => 'private', 'assignee_id' => $banned->id])->assertUnprocessable();
    asUser($creator)->postJson('/api/v1/tasks', ['title' => 'x', 'visibility' => 'private', 'list_id' => $theirs->id])->assertUnprocessable();
    asUser($creator)->patchJson("/api/v1/tasks/{$task->id}", ['assignee_id' => $banned->id])->assertUnprocessable();
    asUser($assignee)->postJson("/api/v1/tasks/{$task->id}/move", ['list_id' => $theirs->id])->assertUnprocessable();
    // Invalid.
    asUser($creator)->postJson('/api/v1/tasks', ['title' => '', 'visibility' => 'private'])->assertUnprocessable();
    // Not allowed, or not visible.
    asUser($stranger)->deleteJson("/api/v1/tasks/{$task->id}")->assertNotFound();
    asUser($creator)->postJson("/api/v1/tasks/{$task->id}/move", ['list_id' => null])->assertForbidden();
    asUser($creator)->postJson("/api/v1/tasks/{$task->id}/return")->assertForbidden();

    Event::assertNotDispatched(TaskChanged::class);
});

test('task.changed goes out only once the change is committed', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();

    DB::beginTransaction();
    asUser($creator)->postJson('/api/v1/tasks', ['title' => 'x', 'visibility' => 'private', 'assignee_id' => $assignee->id])->assertCreated();
    Event::assertNotDispatched(TaskChanged::class);
    DB::rollBack();
    Event::assertNotDispatched(TaskChanged::class);

    DB::beginTransaction();
    $id = asUser($creator)->postJson('/api/v1/tasks', ['title' => 'x', 'visibility' => 'private', 'assignee_id' => $assignee->id])->assertCreated()->json('id');
    Event::assertNotDispatched(TaskChanged::class);
    DB::commit();

    expectOneEachFor($id, [$creator->id, $assignee->id]);
});
