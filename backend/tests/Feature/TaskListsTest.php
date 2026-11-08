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

test('lists are personal: index shows only mine, in position order, with open_count', function () {
    [$me, $other] = User::factory()->count(2)->create();
    $second = TaskList::factory()->create(['user_id' => $me->id, 'name' => 'Second', 'position' => 1]);
    $first = TaskList::factory()->create(['user_id' => $me->id, 'name' => 'First', 'position' => 0]);
    TaskList::factory()->create(['user_id' => $other->id, 'name' => 'Not mine']);

    Task::factory()->count(2)->create(['creator_id' => $me->id, 'list_id' => $first->id]);
    Task::factory()->completed()->create(['creator_id' => $me->id, 'list_id' => $first->id]);
    Task::factory()->create(['creator_id' => $other->id, 'assignee_id' => $me->id, 'list_id' => $second->id]);

    asUser($me)->getJson('/api/v1/task-lists')->assertOk()->assertExactJson([
        ['id' => $first->id, 'name' => 'First', 'position' => 0, 'open_count' => 2],
        ['id' => $second->id, 'name' => 'Second', 'position' => 1, 'open_count' => 1],
    ]);
});

test('a name is trimmed, 1 to 60 characters, Hebrew and emoji kept', function () {
    $me = User::factory()->create();

    asUser($me)->postJson('/api/v1/task-lists', ['name' => "  \u{05E7}\u{05E0}\u{05D9}\u{05D5}\u{05EA} \u{1F6D2}  "])
        ->assertCreated()
        ->assertJson(['name' => "\u{05E7}\u{05E0}\u{05D9}\u{05D5}\u{05EA} \u{1F6D2}", 'position' => 0, 'open_count' => 0]);

    asUser($me)->postJson('/api/v1/task-lists', ['name' => '   '])->assertUnprocessable()->assertJsonValidationErrors('name');
    asUser($me)->postJson('/api/v1/task-lists', [])->assertUnprocessable()->assertJsonValidationErrors('name');
    asUser($me)->postJson('/api/v1/task-lists', ['name' => str_repeat('a', 61)])->assertUnprocessable()->assertJsonValidationErrors('name');
    // Sixty Hebrew letters are sixty characters, not a hundred and twenty bytes.
    asUser($me)->postJson('/api/v1/task-lists', ['name' => str_repeat("\u{05D0}", 60)])->assertCreated();

    $list = TaskList::where('user_id', $me->id)->orderBy('position')->first();
    asUser($me)->patchJson("/api/v1/task-lists/{$list->id}", ['name' => ' Renamed '])->assertOk()->assertJson(['name' => 'Renamed']);
    asUser($me)->patchJson("/api/v1/task-lists/{$list->id}", ['name' => ''])->assertUnprocessable()->assertJsonValidationErrors('name');

    $second = TaskList::where('user_id', $me->id)->orderBy('position')->get()[1];
    expect($second->position)->toBe(1)
        ->and(TaskList::where('user_id', $me->id)->count())->toBe(2);
});

test('the 51st list is refused with task_list_limit', function () {
    $me = User::factory()->create();
    $other = User::factory()->create();
    foreach (range(0, 49) as $i) {
        TaskList::factory()->create(['user_id' => $me->id, 'name' => "List {$i}", 'position' => $i]);
    }

    asUser($me)->postJson('/api/v1/task-lists', ['name' => 'One too many'])
        ->assertUnprocessable()->assertExactJson(['error' => 'task_list_limit']);
    expect(TaskList::where('user_id', $me->id)->count())->toBe(50);

    // The cap is per person.
    asUser($other)->postJson('/api/v1/task-lists', ['name' => 'Mine'])->assertCreated();

    // Deleting one makes room again, and the new list goes last.
    TaskList::where('user_id', $me->id)->where('position', 10)->firstOrFail()->delete();
    asUser($me)->postJson('/api/v1/task-lists', ['name' => 'Fits now'])->assertCreated()->assertJson(['position' => 50]);
});

test("someone else's list answers 404 on rename, reorder and delete", function () {
    [$me, $other] = User::factory()->count(2)->create();
    $theirs = TaskList::factory()->create(['user_id' => $other->id, 'name' => 'Theirs']);

    asUser($me)->patchJson("/api/v1/task-lists/{$theirs->id}", ['name' => 'Mine now'])->assertNotFound();
    asUser($me)->patchJson("/api/v1/task-lists/{$theirs->id}", ['position' => 3])->assertNotFound();
    asUser($me)->deleteJson("/api/v1/task-lists/{$theirs->id}")->assertNotFound();
    asUser($me)->patchJson('/api/v1/task-lists/999999', ['name' => 'x'])->assertNotFound();
    asUser($me)->patchJson('/api/v1/task-lists/abc', ['name' => 'x'])->assertNotFound();

    expect($theirs->fresh()->name)->toBe('Theirs');
});

test('moving a list reorders the owner lists contiguously', function () {
    [$me, $other] = User::factory()->count(2)->create();
    [$a, $b, $c] = collect(['A', 'B', 'C'])->map(fn ($name, $i) => TaskList::factory()->create(['user_id' => $me->id, 'name' => $name, 'position' => $i * 5]))->all();
    $theirs = TaskList::factory()->create(['user_id' => $other->id, 'position' => 7]);

    asUser($me)->patchJson("/api/v1/task-lists/{$c->id}", ['position' => 0])->assertOk()->assertJson(['id' => $c->id, 'position' => 0]);
    $names = fn () => asUser($me)->getJson('/api/v1/task-lists')->json();
    expect(collect($names())->pluck('name', 'position')->all())->toBe([0 => 'C', 1 => 'A', 2 => 'B']);

    // Past the end lands last; negatives are refused.
    asUser($me)->patchJson("/api/v1/task-lists/{$c->id}", ['position' => 99])->assertOk()->assertJson(['position' => 2]);
    expect(collect($names())->pluck('name', 'position')->all())->toBe([0 => 'A', 1 => 'B', 2 => 'C']);
    asUser($me)->patchJson("/api/v1/task-lists/{$c->id}", ['position' => -1])->assertUnprocessable()->assertJsonValidationErrors('position');

    expect($theirs->fresh()->position)->toBe(7);
});

test('deleting a list deletes the tasks I wrote in it and returns the ones others gave me to my inbox', function () {
    [$me, $friend] = User::factory()->count(2)->create();
    $list = TaskList::factory()->create(['user_id' => $me->id]);
    $keep = TaskList::factory()->create(['user_id' => $me->id]);
    $mine = Task::factory()->create(['creator_id' => $me->id, 'list_id' => $list->id]);
    $given = Task::factory()->create(['creator_id' => $friend->id, 'assignee_id' => $me->id, 'list_id' => $list->id]);
    $elsewhere = Task::factory()->create(['creator_id' => $me->id, 'list_id' => $keep->id]);

    asUser($me)->deleteJson("/api/v1/task-lists/{$list->id}")->assertNoContent();

    expect(TaskList::find($list->id))->toBeNull()
        ->and(Task::find($mine->id))->toBeNull()
        ->and($given->fresh()->list_id)->toBeNull()
        ->and($given->fresh()->assignee_id)->toBe($me->id)
        ->and($elsewhere->fresh()->list_id)->toBe($keep->id);
});

test('ensureDefaultList creates "My tasks" once, in the owner\'s locale', function () {
    $service = app(TaskService::class);
    $en = User::factory()->create(['locale' => 'en']);
    $fr = User::factory()->create(['locale' => 'fr']);
    $he = User::factory()->create(['locale' => 'he']);

    $first = $service->ensureDefaultList($en);
    expect($first->name)->toBe('My tasks')
        ->and($first->workspace_id)->toBe(Workspace::default()->id)
        ->and($service->ensureDefaultList($en)->is($first))->toBeTrue()
        ->and(TaskList::where('user_id', $en->id)->count())->toBe(1)
        ->and($service->ensureDefaultList($fr)->name)->toBe('Mes tâches')
        ->and($service->ensureDefaultList($he)->name)->toBe("\u{05D4}\u{05DE}\u{05E9}\u{05D9}\u{05DE}\u{05D5}\u{05EA} \u{05E9}\u{05DC}\u{05D9}");

    // An existing list is never replaced, whatever its name.
    $custom = TaskList::factory()->create(['user_id' => $fr->id, 'name' => 'Custom', 'position' => 9]);
    expect($service->ensureDefaultList($fr)->name)->toBe('Mes tâches')
        ->and(TaskList::where('user_id', $fr->id)->count())->toBe(2);
});
