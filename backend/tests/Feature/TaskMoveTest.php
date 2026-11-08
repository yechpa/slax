<?php

use App\Models\Task;
use App\Models\TaskList;
use App\Models\User;
use App\Services\TaskService;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Auth\Access\AuthorizationException;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

test('the assignee files an inbox task into one of their lists and it leaves the inbox', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();
    $list = TaskList::factory()->create(['user_id' => $assignee->id]);
    Task::factory()->create(['creator_id' => $assignee->id, 'list_id' => $list->id, 'position' => 4]);
    $given = Task::factory()->private()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id, 'position' => 9]);
    $own = Task::factory()->create(['creator_id' => $assignee->id, 'position' => 1]);

    // A task somebody else gave me goes last in my list.
    asUser($assignee)->postJson("/api/v1/tasks/{$given->id}/move", ['list_id' => $list->id])
        ->assertOk()
        ->assertJson(['id' => $given->id, 'list_id' => $list->id, 'assignee' => ['id' => $assignee->id], 'creator' => ['id' => $creator->id]]);
    expect($given->fresh()->list_id)->toBe($list->id)
        ->and($given->fresh()->position)->toBe(5)
        ->and($given->fresh()->assignee_id)->toBe($assignee->id)
        ->and(Task::where('assignee_id', $assignee->id)->whereNull('list_id')->pluck('id')->all())->toBe([$own->id]);

    // So does one of my own.
    asUser($assignee)->postJson("/api/v1/tasks/{$own->id}/move", ['list_id' => $list->id])
        ->assertOk()->assertJson(['list_id' => $list->id]);
    expect(Task::where('assignee_id', $assignee->id)->whereNull('list_id')->count())->toBe(0)
        ->and($own->fresh()->position)->toBe(6);

    // Moving to the list it is already in changes nothing.
    asUser($assignee)->postJson("/api/v1/tasks/{$own->id}/move", ['list_id' => $list->id])
        ->assertOk()->assertJson(['list_id' => $list->id]);
    expect($own->fresh()->position)->toBe(6);
});

test("a task cannot be moved into someone else's list (invalid_list), nor by someone who is not the assignee", function () {
    [$creator, $assignee, $stranger] = User::factory()->count(3)->create();
    $mine = TaskList::factory()->create(['user_id' => $assignee->id]);
    $theirs = TaskList::factory()->create(['user_id' => $creator->id]);
    $public = Task::factory()->public()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);
    $private = Task::factory()->private()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    // The creator's own list, an unknown list, and a list of the stranger's: all invalid for the assignee.
    foreach ([$theirs->id, 999999] as $listId) {
        asUser($assignee)->postJson("/api/v1/tasks/{$public->id}/move", ['list_id' => $listId])
            ->assertUnprocessable()->assertExactJson(['error' => 'invalid_list']);
    }
    // list_id has to be there, an integer or null.
    asUser($assignee)->postJson("/api/v1/tasks/{$public->id}/move", [])->assertUnprocessable()->assertJsonValidationErrors('list_id');
    asUser($assignee)->postJson("/api/v1/tasks/{$public->id}/move", ['list_id' => 'abc'])->assertUnprocessable()->assertJsonValidationErrors('list_id');

    // Not the assignee: the creator and a stranger get 403 on a visible task...
    asUser($creator)->postJson("/api/v1/tasks/{$public->id}/move", ['list_id' => $theirs->id])->assertForbidden();
    asUser($creator)->postJson("/api/v1/tasks/{$private->id}/move", ['list_id' => $theirs->id])->assertForbidden();
    asUser($stranger)->postJson("/api/v1/tasks/{$public->id}/move", ['list_id' => $mine->id])->assertForbidden();
    // ...and 404 on an invisible one, or one that does not exist.
    asUser($stranger)->postJson("/api/v1/tasks/{$private->id}/move", ['list_id' => $mine->id])->assertNotFound();
    asUser($stranger)->postJson('/api/v1/tasks/999999/move', ['list_id' => null])->assertNotFound();

    expect($public->fresh()->list_id)->toBeNull()
        ->and($private->fresh()->list_id)->toBeNull();
});

test('moving to null puts it back in the inbox', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();
    $list = TaskList::factory()->create(['user_id' => $assignee->id]);
    $task = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id, 'list_id' => $list->id, 'position' => 0]);
    Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id, 'position' => 6]);

    asUser($assignee)->postJson("/api/v1/tasks/{$task->id}/move", ['list_id' => null])
        ->assertOk()->assertJson(['list_id' => null]);
    expect($task->fresh())->list_id->toBeNull()->position->toBe(7);
});

test('moving into a full inbox is refused with inbox_full, but a task already in the inbox may "move" there', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();
    $list = TaskList::factory()->create(['user_id' => $assignee->id]);
    $filed = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id, 'list_id' => $list->id]);
    Task::factory()->count(200)->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    asUser($assignee)->postJson("/api/v1/tasks/{$filed->id}/move", ['list_id' => null])
        ->assertUnprocessable()->assertExactJson(['error' => 'inbox_full']);
    expect($filed->fresh()->list_id)->toBe($list->id);

    $inboxed = Task::where('assignee_id', $assignee->id)->whereNull('list_id')->firstOrFail();
    asUser($assignee)->postJson("/api/v1/tasks/{$inboxed->id}/move", ['list_id' => null])->assertOk();
});

test('moving into a list of 500 is refused', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();
    $full = TaskList::factory()->create(['user_id' => $assignee->id]);
    $other = TaskList::factory()->create(['user_id' => $assignee->id]);
    Task::factory()->count(450)->create(['creator_id' => $assignee->id, 'list_id' => $full->id]);
    Task::factory()->count(50)->completed()->create(['creator_id' => $assignee->id, 'list_id' => $full->id]);
    $given = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);
    $inList = Task::factory()->create(['creator_id' => $assignee->id, 'list_id' => $other->id]);

    asUser($assignee)->postJson("/api/v1/tasks/{$given->id}/move", ['list_id' => $full->id])
        ->assertUnprocessable()->assertExactJson(['error' => 'task_limit']);
    asUser($assignee)->postJson("/api/v1/tasks/{$inList->id}/move", ['list_id' => $full->id])
        ->assertUnprocessable()->assertExactJson(['error' => 'task_limit']);
    expect(Task::where('list_id', $full->id)->count())->toBe(500)
        ->and($given->fresh()->list_id)->toBeNull();

    // A task already in the full list is not refused by it; one less and the next fits.
    $member = Task::where('list_id', $full->id)->firstOrFail();
    asUser($assignee)->postJson("/api/v1/tasks/{$member->id}/move", ['list_id' => $full->id])->assertOk();
    $member->delete();
    asUser($assignee)->postJson("/api/v1/tasks/{$given->id}/move", ['list_id' => $full->id])->assertOk()->assertJson(['list_id' => $full->id]);
});

test('returning to the author puts it in the author\'s inbox; the creator cannot return their own task', function () {
    [$creator, $assignee, $stranger] = User::factory()->count(3)->create();
    $creatorList = TaskList::factory()->create(['user_id' => $creator->id]);
    $list = TaskList::factory()->create(['user_id' => $assignee->id]);
    Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $creator->id, 'position' => 3]);
    Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $creator->id, 'list_id' => $creatorList->id, 'position' => 40]);
    $filed = Task::factory()->public()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id, 'list_id' => $list->id]);
    $inboxed = Task::factory()->private()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    // Only the assignee returns it; the creator and a stranger do not (403 visible, 404 invisible).
    asUser($creator)->postJson("/api/v1/tasks/{$filed->id}/return")->assertForbidden();
    asUser($stranger)->postJson("/api/v1/tasks/{$filed->id}/return")->assertForbidden();
    asUser($stranger)->postJson("/api/v1/tasks/{$inboxed->id}/return")->assertNotFound();
    expect($filed->fresh()->assignee_id)->toBe($assignee->id);

    // Filed or not, it lands in the author's inbox, last.
    asUser($assignee)->postJson("/api/v1/tasks/{$filed->id}/return")
        ->assertOk()
        ->assertJson(['id' => $filed->id, 'list_id' => null, 'assignee' => ['id' => $creator->id], 'creator' => ['id' => $creator->id]]);
    asUser($assignee)->postJson("/api/v1/tasks/{$inboxed->id}/return")
        ->assertOk()->assertJson(['list_id' => null, 'assignee' => ['id' => $creator->id]]);
    expect($filed->fresh()->position)->toBe(4)
        ->and($inboxed->fresh()->position)->toBe(5)
        ->and($filed->fresh()->assignee_id)->toBe($creator->id)
        ->and($filed->fresh()->list_id)->toBeNull();

    // A task you created and hold yourself cannot be returned: to whom?
    $own = Task::factory()->create(['creator_id' => $assignee->id]);
    asUser($assignee)->postJson("/api/v1/tasks/{$own->id}/return")->assertForbidden();
    // The author now holds the returned task and is its creator: nothing more to return.
    asUser($creator)->postJson("/api/v1/tasks/{$filed->id}/return")->assertForbidden();
    expect($own->fresh()->assignee_id)->toBe($assignee->id);

    // The author's inbox cap applies: 3 there, + 196 more = 199, the next return fits and the one after does not.
    Task::factory()->count(196)->create(['creator_id' => $creator->id]);
    $again = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);
    asUser($assignee)->postJson("/api/v1/tasks/{$again->id}/return")->assertOk();
    $last = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);
    asUser($assignee)->postJson("/api/v1/tasks/{$last->id}/return")
        ->assertUnprocessable()->assertExactJson(['error' => 'inbox_full']);
    expect($last->fresh()->assignee_id)->toBe($assignee->id)
        ->and(Task::where('assignee_id', $creator->id)->whereNull('list_id')->count())->toBe(200);
});

test('after a return the former assignee no longer sees a private task', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();
    $private = Task::factory()->private()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);
    $public = Task::factory()->public()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    asUser($assignee)->postJson("/api/v1/tasks/{$private->id}/return")->assertOk();
    asUser($assignee)->postJson("/api/v1/tasks/{$public->id}/return")->assertOk();

    expect(Task::visibleTo($assignee)->whereKey($private->id)->exists())->toBeFalse()
        ->and(Task::visibleTo($assignee)->whereKey($public->id)->exists())->toBeTrue();
    // The former assignee meets a 404 on the private task, a 403 on the public one.
    asUser($assignee)->postJson("/api/v1/tasks/{$private->id}/return")->assertNotFound();
    asUser($assignee)->postJson("/api/v1/tasks/{$private->id}/move", ['list_id' => null])->assertNotFound();
    asUser($assignee)->postJson("/api/v1/tasks/{$public->id}/move", ['list_id' => null])->assertForbidden();
});

test('the service decides on fresh state: a stale instance of a task that changed hands is refused, and records the former assignee', function () {
    [$creator, $assignee, $newcomer] = User::factory()->count(3)->create();
    $service = app(TaskService::class);
    $list = TaskList::factory()->create(['user_id' => $assignee->id]);
    $task = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    // The assignee read the task, then the creator handed it to somebody else.
    $stale = Task::findOrFail($task->id);
    $service->updateTask($task, ['assignee_id' => $newcomer->id]);

    expect(fn () => $service->moveTask($stale, $list->id))->toThrow(AuthorizationException::class)
        ->and(fn () => $service->returnToAuthor($stale))->toThrow(AuthorizationException::class)
        ->and($task->fresh()->assignee_id)->toBe($newcomer->id)
        ->and($task->fresh()->list_id)->toBeNull();

    $returned = $service->returnToAuthor(Task::findOrFail($task->id));
    expect($returned->previousAssigneeId)->toBe($newcomer->id)
        ->and($returned->getAttributes())->not->toHaveKey('previousAssigneeId');
});

test('moving and returning need a session and are rate limited with the other task writes', function () {
    [$creator, $assignee] = User::factory()->count(2)->create();
    $task = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    $this->postJson("/api/v1/tasks/{$task->id}/move", ['list_id' => null])->assertUnauthorized();
    $this->postJson("/api/v1/tasks/{$task->id}/return")->assertUnauthorized();

    $statuses = collect(range(1, 61))->map(fn () => asUser($assignee)->postJson("/api/v1/tasks/{$task->id}/move", ['list_id' => null])->status());
    expect($statuses->first())->toBe(200)
        ->and($statuses->last())->toBe(429);
});
