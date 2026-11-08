<?php

use App\Models\Task;
use App\Models\TaskList;
use App\Models\User;
use Database\Seeders\DefaultWorkspaceSeeder;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

/** @return list<int> */
function visibleTaskIds(User $viewer): array
{
    return Task::visibleTo($viewer)->orderBy('id')->pluck('id')->all();
}

test('visibleTo returns public tasks and private ones the viewer created or holds, nothing else', function () {
    [$alice, $bob, $carol, $dave] = User::factory()->count(4)->create();

    $aliceForBob = Task::factory()->private()->create(['creator_id' => $alice->id, 'assignee_id' => $bob->id]);
    $davePublic = Task::factory()->public()->create(['creator_id' => $dave->id, 'assignee_id' => $dave->id]);

    $both = [$aliceForBob->id, $davePublic->id];
    expect(visibleTaskIds($alice))->toBe($both)
        ->and(visibleTaskIds($bob))->toBe($both)
        ->and(visibleTaskIds($carol))->toBe([$davePublic->id])
        ->and(visibleTaskIds($dave))->toBe([$davePublic->id]);

    expect($aliceForBob->isVisibleTo($alice))->toBeTrue()
        ->and($aliceForBob->isVisibleTo($bob))->toBeTrue()
        ->and($aliceForBob->isVisibleTo($carol))->toBeFalse()
        ->and($davePublic->isVisibleTo($carol))->toBeTrue();
});

test('deleting a user deletes the tasks they created', function () {
    [$alice, $bob] = User::factory()->count(2)->create();
    Task::factory()->assignedTo($bob)->create(['creator_id' => $alice->id]);
    $kept = Task::factory()->create(['creator_id' => $bob->id, 'assignee_id' => $bob->id]);

    $alice->delete();

    expect(Task::pluck('id')->all())->toBe([$kept->id]);
});

test('deleting a list leaves its tasks unfiled at the database level', function () {
    $alice = User::factory()->create();
    $list = TaskList::factory()->create(['user_id' => $alice->id]);
    $task = Task::factory()->create(['creator_id' => $alice->id, 'assignee_id' => $alice->id, 'list_id' => $list->id]);

    $list->delete();

    expect($task->fresh()->list_id)->toBeNull()
        ->and(Task::factory()->completed()->make()->isCompleted())->toBeTrue()
        ->and($task->isCompleted())->toBeFalse();
});
