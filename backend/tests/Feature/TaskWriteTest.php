<?php

use App\Models\Task;
use App\Models\TaskList;
use App\Models\User;
use App\Models\Workspace;
use App\Services\TaskService;
use Database\Seeders\DefaultWorkspaceSeeder;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

/** @param array<string, mixed> $attributes */
function newTask(array $attributes = []): array
{
    return ['title' => 'Buy milk', 'visibility' => 'private', ...$attributes];
}

test('create for myself lands in the given list, or in "My tasks" when I have none', function () {
    $me = User::factory()->create();

    // No list yet: "My tasks" is created, and the task goes in it.
    $first = asUser($me)->postJson('/api/v1/tasks', newTask())->assertCreated()
        ->assertExactJson([
            'id' => Task::firstOrFail()->id,
            'title' => 'Buy milk',
            'visibility' => 'private',
            'completed' => false,
            'completed_at' => null,
            'list_id' => TaskList::where('user_id', $me->id)->firstOrFail()->id,
            'creator' => ['id' => $me->id, 'name' => $me->name, 'avatar_url' => $me->avatar_url],
            'assignee' => ['id' => $me->id, 'name' => $me->name, 'avatar_url' => $me->avatar_url],
            'created_at' => Task::firstOrFail()->created_at->toISOString(),
        ]);
    expect(Task::firstOrFail()->position)->toBe(0);
    $myTasks = TaskList::where('user_id', $me->id)->firstOrFail();
    expect($myTasks->name)->toBe('My tasks')
        ->and($first->json())->not->toHaveKey('email')
        ->and($first->json('creator'))->not->toHaveKey('email');

    // A second task without list_id goes to the same list, last.
    $second = asUser($me)->postJson('/api/v1/tasks', newTask(['title' => 'Second', 'list_id' => null]))->assertCreated()
        ->assertJson(['list_id' => $myTasks->id]);
    expect(TaskList::where('user_id', $me->id)->count())->toBe(1)
        ->and(Task::findOrFail($second->json('id'))->position)->toBe(1);

    // An explicit list of mine, and an explicit assignee that is me.
    $other = TaskList::factory()->create(['user_id' => $me->id, 'position' => 5]);
    asUser($me)->postJson('/api/v1/tasks', newTask(['list_id' => $other->id, 'assignee_id' => $me->id, 'visibility' => 'public']))
        ->assertCreated()
        ->assertJson(['list_id' => $other->id, 'visibility' => 'public']);

    $task = Task::latest('id')->firstOrFail();
    expect($task->position)->toBe(0)
        ->and($task->workspace_id)->toBe(Workspace::default()->id)
        ->and($task->creator_id)->toBe($me->id)
        ->and($task->assignee_id)->toBe($me->id);
});

test('visibility is required and only public or private', function () {
    $me = User::factory()->create();

    asUser($me)->postJson('/api/v1/tasks', ['title' => 'x'])->assertUnprocessable()->assertJsonValidationErrors('visibility');
    asUser($me)->postJson('/api/v1/tasks', newTask(['visibility' => 'secret']))->assertUnprocessable()->assertJsonValidationErrors('visibility');
    asUser($me)->postJson('/api/v1/tasks', newTask(['visibility' => '']))->assertUnprocessable()->assertJsonValidationErrors('visibility');
    asUser($me)->postJson('/api/v1/tasks', newTask(['visibility' => 'public']))->assertCreated();
    asUser($me)->postJson('/api/v1/tasks', newTask(['visibility' => 'private']))->assertCreated();

    $task = Task::factory()->create(['creator_id' => $me->id]);
    asUser($me)->patchJson("/api/v1/tasks/{$task->id}", ['visibility' => 'secret'])->assertUnprocessable()->assertJsonValidationErrors('visibility');
    asUser($me)->patchJson("/api/v1/tasks/{$task->id}", ['visibility' => 'public'])->assertOk()->assertJson(['visibility' => 'public']);
});

test('create for a colleague puts it in their inbox with no list and ignores list_id', function () {
    [$me, $colleague] = User::factory()->count(2)->create();
    $mine = TaskList::factory()->create(['user_id' => $me->id]);
    $theirs = TaskList::factory()->create(['user_id' => $colleague->id]);
    Task::factory()->create(['creator_id' => $colleague->id, 'position' => 3]);

    $given = asUser($me)->postJson('/api/v1/tasks', newTask(['assignee_id' => $colleague->id, 'list_id' => $mine->id]))
        ->assertCreated()
        ->assertJson([
            'list_id' => null,
            'creator' => ['id' => $me->id],
            'assignee' => ['id' => $colleague->id, 'name' => $colleague->name],
        ]);
    expect(Task::findOrFail($given->json('id'))->position)->toBe(4);
    // Even the colleague's own list is ignored: the task lands in the inbox.
    asUser($me)->postJson('/api/v1/tasks', newTask(['assignee_id' => $colleague->id, 'list_id' => $theirs->id]))
        ->assertCreated()->assertJson(['list_id' => null]);

    expect(Task::where('assignee_id', $colleague->id)->whereNull('list_id')->count())->toBe(3)
        ->and(TaskList::where('user_id', $me->id)->count())->toBe(1);
});

test("list_id of someone else's list is refused with invalid_list", function () {
    [$me, $other] = User::factory()->count(2)->create();
    $theirs = TaskList::factory()->create(['user_id' => $other->id]);

    asUser($me)->postJson('/api/v1/tasks', newTask(['list_id' => $theirs->id]))
        ->assertUnprocessable()->assertExactJson(['error' => 'invalid_list']);
    asUser($me)->postJson('/api/v1/tasks', newTask(['list_id' => 999999]))
        ->assertUnprocessable()->assertExactJson(['error' => 'invalid_list']);

    expect(Task::count())->toBe(0);
});

test('a banned or unknown assignee is refused with invalid_assignee', function () {
    [$me, $colleague] = User::factory()->count(2)->create();
    $banned = User::factory()->create(['banned_at' => now()]);

    asUser($me)->postJson('/api/v1/tasks', newTask(['assignee_id' => $banned->id]))
        ->assertUnprocessable()->assertExactJson(['error' => 'invalid_assignee']);
    asUser($me)->postJson('/api/v1/tasks', newTask(['assignee_id' => 999999]))
        ->assertUnprocessable()->assertExactJson(['error' => 'invalid_assignee']);

    $task = Task::factory()->create(['creator_id' => $me->id]);
    asUser($me)->patchJson("/api/v1/tasks/{$task->id}", ['assignee_id' => $banned->id])
        ->assertUnprocessable()->assertExactJson(['error' => 'invalid_assignee']);
    asUser($me)->patchJson("/api/v1/tasks/{$task->id}", ['assignee_id' => 999999])
        ->assertUnprocessable()->assertExactJson(['error' => 'invalid_assignee']);

    expect(Task::count())->toBe(1)
        ->and($task->fresh()->assignee_id)->toBe($me->id);
});

test('a colleague with 200 unfiled tasks refuses a 201st with inbox_full', function () {
    [$me, $colleague, $third] = User::factory()->count(3)->create();
    $filed = TaskList::factory()->create(['user_id' => $colleague->id]);
    Task::factory()->count(200)->create(['creator_id' => $third->id, 'assignee_id' => $colleague->id]);
    // Filed tasks do not count against the inbox.
    Task::factory()->count(3)->create(['creator_id' => $third->id, 'assignee_id' => $colleague->id, 'list_id' => $filed->id]);

    asUser($me)->postJson('/api/v1/tasks', newTask(['assignee_id' => $colleague->id]))
        ->assertUnprocessable()->assertExactJson(['error' => 'inbox_full']);
    expect(Task::where('assignee_id', $colleague->id)->count())->toBe(203);

    // Reassigning into the full inbox is refused the same way, and the task stays put.
    $mine = Task::factory()->create(['creator_id' => $me->id]);
    asUser($me)->patchJson("/api/v1/tasks/{$mine->id}", ['assignee_id' => $colleague->id])
        ->assertUnprocessable()->assertExactJson(['error' => 'inbox_full']);
    expect($mine->fresh()->assignee_id)->toBe($me->id);

    // One place frees up: the next one fits.
    Task::where('assignee_id', $colleague->id)->whereNull('list_id')->firstOrFail()->delete();
    asUser($me)->postJson('/api/v1/tasks', newTask(['assignee_id' => $colleague->id]))->assertCreated();
    // The cap is per inbox.
    asUser($me)->postJson('/api/v1/tasks', newTask(['assignee_id' => $third->id]))->assertCreated();
});

test('the 501st task of a list is refused with task_limit, completed ones included', function () {
    [$me, $other] = User::factory()->count(2)->create();
    $list = TaskList::factory()->create(['user_id' => $me->id]);
    $elsewhere = TaskList::factory()->create(['user_id' => $me->id]);
    Task::factory()->count(450)->create(['creator_id' => $me->id, 'list_id' => $list->id]);
    Task::factory()->count(50)->completed()->create(['creator_id' => $me->id, 'list_id' => $list->id]);

    asUser($me)->postJson('/api/v1/tasks', newTask(['list_id' => $list->id]))
        ->assertUnprocessable()->assertExactJson(['error' => 'task_limit']);
    // Without list_id the first list is the default one: still full.
    asUser($me)->postJson('/api/v1/tasks', newTask())
        ->assertUnprocessable()->assertExactJson(['error' => 'task_limit']);
    expect(Task::where('list_id', $list->id)->count())->toBe(500);

    // The cap is per list; tasks others gave me to file elsewhere do not matter here.
    asUser($me)->postJson('/api/v1/tasks', newTask(['list_id' => $elsewhere->id]))->assertCreated();
    // Deleting one makes room, and the new task goes last.
    Task::where('list_id', $list->id)->firstOrFail()->delete();
    asUser($me)->postJson('/api/v1/tasks', newTask(['list_id' => $list->id]))->assertCreated();
    expect(Task::where('list_id', $list->id)->count())->toBe(500);
});

test('a title of 200 Hebrew letters is accepted and 201 refused; blank and whitespace-only refused; trimmed', function () {
    $me = User::factory()->create();
    $aleph = "\u{05D0}";

    // 200 letters are 400 bytes: the limit counts characters.
    asUser($me)->postJson('/api/v1/tasks', newTask(['title' => str_repeat($aleph, 200)]))
        ->assertCreated()->assertJson(['title' => str_repeat($aleph, 200)]);
    asUser($me)->postJson('/api/v1/tasks', newTask(['title' => str_repeat($aleph, 201)]))
        ->assertUnprocessable()->assertJsonValidationErrors('title');
    asUser($me)->postJson('/api/v1/tasks', newTask(['title' => '']))->assertUnprocessable()->assertJsonValidationErrors('title');
    asUser($me)->postJson('/api/v1/tasks', newTask(['title' => "  \t\n "]))->assertUnprocessable()->assertJsonValidationErrors('title');
    asUser($me)->postJson('/api/v1/tasks', ['visibility' => 'private'])->assertUnprocessable()->assertJsonValidationErrors('title');
    asUser($me)->postJson('/api/v1/tasks', newTask(['title' => ['a']]))->assertUnprocessable()->assertJsonValidationErrors('title');

    asUser($me)->postJson('/api/v1/tasks', newTask(['title' => "  \u{05E7}\u{05E0}\u{05D4} \u{05D7}\u{05DC}\u{05D1}  "]))
        ->assertCreated()->assertJson(['title' => "\u{05E7}\u{05E0}\u{05D4} \u{05D7}\u{05DC}\u{05D1}"]);

    $task = Task::factory()->create(['creator_id' => $me->id]);
    asUser($me)->patchJson("/api/v1/tasks/{$task->id}", ['title' => '  Renamed '])->assertOk()->assertJson(['title' => 'Renamed']);
    asUser($me)->patchJson("/api/v1/tasks/{$task->id}", ['title' => '   '])->assertUnprocessable()->assertJsonValidationErrors('title');
    asUser($me)->patchJson("/api/v1/tasks/{$task->id}", ['title' => str_repeat($aleph, 201)])->assertUnprocessable()->assertJsonValidationErrors('title');
    expect($task->fresh()->title)->toBe('Renamed')
        ->and(Task::count())->toBe(3);
});

test('only the creator edits, reassigns or deletes: the assignee gets 403 on a public task and 404 on a stranger\'s private one', function () {
    [$creator, $assignee, $stranger] = User::factory()->count(3)->create();
    $public = Task::factory()->public()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id, 'title' => 'Public']);
    $private = Task::factory()->private()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id, 'title' => 'Private']);

    // The assignee sees both and may change neither.
    foreach ([$public, $private] as $task) {
        asUser($assignee)->patchJson("/api/v1/tasks/{$task->id}", ['title' => 'Mine now'])->assertForbidden();
        asUser($assignee)->patchJson("/api/v1/tasks/{$task->id}", ['visibility' => 'public'])->assertForbidden();
        asUser($assignee)->patchJson("/api/v1/tasks/{$task->id}", ['assignee_id' => $stranger->id])->assertForbidden();
        asUser($assignee)->deleteJson("/api/v1/tasks/{$task->id}")->assertForbidden();
    }

    // A stranger sees the public one (403) and not the private one (404).
    asUser($stranger)->patchJson("/api/v1/tasks/{$public->id}", ['title' => 'x'])->assertForbidden();
    asUser($stranger)->deleteJson("/api/v1/tasks/{$public->id}")->assertForbidden();
    asUser($stranger)->patchJson("/api/v1/tasks/{$private->id}", ['title' => 'x'])->assertNotFound();
    asUser($stranger)->deleteJson("/api/v1/tasks/{$private->id}")->assertNotFound();
    asUser($stranger)->putJson("/api/v1/tasks/{$private->id}/completion", ['completed' => true])->assertNotFound();
    asUser($stranger)->patchJson('/api/v1/tasks/999999', ['title' => 'x'])->assertNotFound();
    asUser($stranger)->patchJson('/api/v1/tasks/abc', ['title' => 'x'])->assertNotFound();

    expect($public->fresh()->title)->toBe('Public')
        ->and($private->fresh()->title)->toBe('Private')
        ->and(Task::count())->toBe(2);

    // The creator edits and deletes, even once the task is somebody else's.
    asUser($creator)->patchJson("/api/v1/tasks/{$private->id}", ['title' => 'Edited', 'visibility' => 'public'])
        ->assertOk()->assertJson(['title' => 'Edited', 'visibility' => 'public']);
    asUser($creator)->deleteJson("/api/v1/tasks/{$private->id}")->assertNoContent();
    asUser($creator)->deleteJson("/api/v1/tasks/{$public->id}")->assertNoContent();
    expect(Task::count())->toBe(0);
});

test('reassigning clears the list and the former assignee loses a private task', function () {
    [$creator, $assignee, $newcomer] = User::factory()->count(3)->create();
    $list = TaskList::factory()->create(['user_id' => $assignee->id]);
    $task = Task::factory()->private()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id, 'list_id' => $list->id, 'position' => 7]);
    Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $newcomer->id, 'position' => 2]);

    expect(Task::visibleTo($assignee)->whereKey($task->id)->exists())->toBeTrue();

    asUser($creator)->patchJson("/api/v1/tasks/{$task->id}", ['assignee_id' => $newcomer->id])
        ->assertOk()
        ->assertJson(['list_id' => null, 'assignee' => ['id' => $newcomer->id]]);

    expect($task->fresh()->list_id)->toBeNull()
        ->and($task->fresh()->position)->toBe(3)
        ->and($task->fresh()->assignee_id)->toBe($newcomer->id)
        ->and(Task::visibleTo($assignee)->whereKey($task->id)->exists())->toBeFalse()
        ->and(Task::visibleTo($newcomer)->whereKey($task->id)->exists())->toBeTrue();
    // The former assignee now meets a 404, not a 403.
    asUser($assignee)->patchJson("/api/v1/tasks/{$task->id}", ['title' => 'x'])->assertNotFound();
    asUser($assignee)->putJson("/api/v1/tasks/{$task->id}/completion", ['completed' => true])->assertNotFound();

    // Handing it back to the creator puts it in the creator's inbox.
    asUser($creator)->patchJson("/api/v1/tasks/{$task->id}", ['assignee_id' => $creator->id])
        ->assertOk()->assertJson(['list_id' => null, 'assignee' => ['id' => $creator->id]]);

    // Naming the current assignee again changes nothing, the list included.
    $filed = Task::factory()->create(['creator_id' => $creator->id, 'list_id' => TaskList::factory()->create(['user_id' => $creator->id])->id]);
    asUser($creator)->patchJson("/api/v1/tasks/{$filed->id}", ['assignee_id' => $creator->id, 'title' => 'Kept'])
        ->assertOk()->assertJson(['list_id' => $filed->list_id, 'title' => 'Kept']);
});

test('updateTask records the former assignee on the returned model, only when the assignee changed', function () {
    [$creator, $assignee, $newcomer] = User::factory()->count(3)->create();
    $service = app(TaskService::class);
    $task = Task::factory()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    expect($service->updateTask($task, ['title' => 'Only a title'])->previousAssigneeId)->toBeNull();

    $updated = $service->updateTask($task, ['assignee_id' => $newcomer->id]);
    expect($updated->previousAssigneeId)->toBe($assignee->id)
        ->and($updated->assignee_id)->toBe($newcomer->id)
        // A plain property: never written to the database.
        ->and($updated->getAttributes())->not->toHaveKey('previousAssigneeId')
        ->and($task->fresh()->assignee_id)->toBe($newcomer->id);
});

test('updateTask decides on fresh state: a stale instance filed meanwhile by its assignee is still unfiled when reassigned', function () {
    [$creator, $assignee, $newcomer] = User::factory()->count(3)->create();
    $service = app(TaskService::class);
    $list = TaskList::factory()->create(['user_id' => $assignee->id]);
    $stale = Task::factory()->public()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    // The assignee files it while the creator's request still holds the task as it was (unfiled).
    $service->moveTask(Task::findOrFail($stale->id), $list->id);
    expect($stale->list_id)->toBeNull();

    $updated = $service->updateTask($stale, ['assignee_id' => $newcomer->id]);

    // Never left in a list of somebody who no longer holds it.
    expect($stale->fresh())->assignee_id->toBe($newcomer->id)->list_id->toBeNull()
        ->and($updated)->assignee_id->toBe($newcomer->id)->list_id->toBeNull()->previousAssigneeId->toBe($assignee->id);

    // A plain edit on a stale instance keeps what changed meanwhile.
    $again = Task::findOrFail($stale->id);
    $service->moveTask(Task::findOrFail($stale->id), TaskList::factory()->create(['user_id' => $newcomer->id])->id);
    $edited = $service->updateTask($again, ['title' => 'Renamed']);
    expect($stale->fresh())->title->toBe('Renamed')->list_id->not->toBeNull()
        ->and($edited->list_id)->toBe($stale->fresh()->list_id);
});

test('creator and assignee may complete and reopen, a stranger may not', function () {
    [$creator, $assignee, $stranger] = User::factory()->count(3)->create();
    $public = Task::factory()->public()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);
    $private = Task::factory()->private()->create(['creator_id' => $creator->id, 'assignee_id' => $assignee->id]);

    $done = asUser($assignee)->putJson("/api/v1/tasks/{$public->id}/completion", ['completed' => true])
        ->assertOk()->assertJson(['id' => $public->id, 'completed' => true]);
    expect($done->json('completed_at'))->not->toBeNull()
        ->and($public->fresh()->completed_at)->not->toBeNull();

    // Completing again keeps the first completion time.
    $at = $public->fresh()->completed_at->toISOString();
    asUser($creator)->putJson("/api/v1/tasks/{$public->id}/completion", ['completed' => true])
        ->assertOk()->assertJson(['completed_at' => $at]);

    asUser($creator)->putJson("/api/v1/tasks/{$public->id}/completion", ['completed' => false])
        ->assertOk()->assertJson(['completed' => false, 'completed_at' => null]);
    expect($public->fresh()->completed_at)->toBeNull();

    asUser($creator)->putJson("/api/v1/tasks/{$private->id}/completion", ['completed' => true])->assertOk()->assertJson(['completed' => true]);
    asUser($assignee)->putJson("/api/v1/tasks/{$private->id}/completion", ['completed' => false])->assertOk()->assertJson(['completed' => false]);

    // A stranger: 403 on a public task, 404 on a private one; nothing changes.
    asUser($stranger)->putJson("/api/v1/tasks/{$public->id}/completion", ['completed' => true])->assertForbidden();
    asUser($stranger)->putJson("/api/v1/tasks/{$private->id}/completion", ['completed' => true])->assertNotFound();
    expect($public->fresh()->completed_at)->toBeNull()
        ->and($private->fresh()->completed_at)->toBeNull();

    // `completed` is a required boolean.
    asUser($creator)->putJson("/api/v1/tasks/{$public->id}/completion", [])->assertUnprocessable()->assertJsonValidationErrors('completed');
    asUser($creator)->putJson("/api/v1/tasks/{$public->id}/completion", ['completed' => 'maybe'])->assertUnprocessable()->assertJsonValidationErrors('completed');
});

test('task writes need a session and are rate limited', function () {
    $me = User::factory()->create();
    $task = Task::factory()->create(['creator_id' => $me->id]);

    $this->postJson('/api/v1/tasks', newTask())->assertUnauthorized();
    $this->patchJson("/api/v1/tasks/{$task->id}", ['title' => 'x'])->assertUnauthorized();
    $this->putJson("/api/v1/tasks/{$task->id}/completion", ['completed' => true])->assertUnauthorized();
    $this->deleteJson("/api/v1/tasks/{$task->id}")->assertUnauthorized();

    $banned = User::factory()->create(['banned_at' => now()]);
    asUser($banned)->postJson('/api/v1/tasks', newTask())->assertForbidden();

    // The `tasks` limiter is 60 a minute per person.
    $tooMany = collect(range(1, 61))->map(fn () => asUser($me)->putJson("/api/v1/tasks/{$task->id}/completion", ['completed' => true])->status());
    expect($tooMany->last())->toBe(429)
        ->and($tooMany->first())->toBe(200);
});
