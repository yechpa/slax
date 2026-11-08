<?php

use App\Events\TaskChanged;
use App\Models\Task;
use App\Models\TaskList;
use App\Models\User;
use App\Services\TaskService;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Support\Facades\Event;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

test('a task for me and two colleagues becomes one copy each, mine in my list and theirs in their inbox', function () {
    [$me, $bob, $carol] = User::factory()->count(3)->create();
    $list = TaskList::factory()->create(['user_id' => $me->id]);

    $response = asUser($me)->postJson('/api/v1/tasks', [
        'title' => 'Plan trip', 'visibility' => 'public', 'list_id' => $list->id,
        'assignee_ids' => [$bob->id, $me->id, $carol->id],
    ])->assertCreated();

    expect(Task::count())->toBe(3)
        ->and($response->json('assignee.id'))->toBe($me->id)
        ->and($response->json('list_id'))->toBe($list->id)
        ->and($response->json())->not->toHaveKey('group_id');
    $copies = Task::orderBy('id')->get();
    expect($copies->pluck('group_id')->unique()->count())->toBe(1)
        ->and($copies->first()->group_id)->not->toBeNull()
        ->and($copies->pluck('assignee_id')->all())->toEqualCanonicalizing([$me->id, $bob->id, $carol->id])
        ->and($copies->pluck('creator_id')->unique()->all())->toBe([$me->id])
        ->and($copies->pluck('title')->unique()->all())->toBe(['Plan trip'])
        ->and($copies->pluck('visibility')->unique()->all())->toBe(['public'])
        ->and(Task::where('assignee_id', $bob->id)->firstOrFail()->list_id)->toBeNull()
        ->and(Task::where('assignee_id', $carol->id)->firstOrFail()->list_id)->toBeNull();
});

test('one person only keeps no group', function () {
    [$me, $bob] = User::factory()->count(2)->create();

    asUser($me)->postJson('/api/v1/tasks', ['title' => 'A', 'visibility' => 'private', 'assignee_ids' => [$bob->id]])->assertCreated();
    asUser($me)->postJson('/api/v1/tasks', ['title' => 'B', 'visibility' => 'private', 'assignee_ids' => [$bob->id, $bob->id]])->assertCreated();

    expect(Task::count())->toBe(2)->and(Task::whereNotNull('group_id')->count())->toBe(0);
});

test('without me in the list the creator keeps nothing, and the first colleague answers', function () {
    [$me, $bob, $carol] = User::factory()->count(3)->create();

    $response = asUser($me)->postJson('/api/v1/tasks', ['title' => 'Two', 'visibility' => 'private', 'assignee_ids' => [$bob->id, $carol->id]])
        ->assertCreated();

    expect($response->json('assignee.id'))->toBe($bob->id)
        ->and(Task::where('assignee_id', $me->id)->count())->toBe(0)
        ->and(TaskList::where('user_id', $me->id)->count())->toBe(0);
});

test('a banned or unknown person refuses the whole request and creates nothing', function () {
    [$me, $bob] = User::factory()->count(2)->create();
    $banned = User::factory()->create(['banned_at' => now()]);

    asUser($me)->postJson('/api/v1/tasks', ['title' => 'X', 'visibility' => 'private', 'assignee_ids' => [$bob->id, $banned->id]])
        ->assertUnprocessable()->assertJson(['error' => 'invalid_assignee']);
    asUser($me)->postJson('/api/v1/tasks', ['title' => 'X', 'visibility' => 'private', 'assignee_ids' => [$bob->id, 999999]])
        ->assertUnprocessable()->assertJson(['error' => 'invalid_assignee']);

    expect(Task::count())->toBe(0)->and(TaskList::count())->toBe(0);
});

test('one full inbox refuses the whole request and creates nothing', function () {
    [$me, $bob, $carol] = User::factory()->count(3)->create();
    Task::factory()->count(TaskService::MAX_INBOX)->create(['creator_id' => $carol->id, 'assignee_id' => $carol->id]);

    asUser($me)->postJson('/api/v1/tasks', ['title' => 'X', 'visibility' => 'private', 'assignee_ids' => [$bob->id, $carol->id]])
        ->assertUnprocessable()->assertJson(['error' => 'inbox_full']);

    expect(Task::where('creator_id', $me->id)->count())->toBe(0);
});

test('assignee_ids is validated: a list of 1 to 10 integers', function () {
    $me = User::factory()->create();

    foreach ([[], 'x', ['a'], range(1, 11)] as $bad) {
        asUser($me)->postJson('/api/v1/tasks', ['title' => 'X', 'visibility' => 'private', 'assignee_ids' => $bad])->assertUnprocessable();
    }
    expect(Task::count())->toBe(0);
});

test('each copy is ticked, filed and returned on its own', function () {
    [$me, $bob] = User::factory()->count(2)->create();
    asUser($me)->postJson('/api/v1/tasks', ['title' => 'Shared', 'visibility' => 'public', 'assignee_ids' => [$me->id, $bob->id]])->assertCreated();
    $mine = Task::where('assignee_id', $me->id)->firstOrFail();
    $his = Task::where('assignee_id', $bob->id)->firstOrFail();

    asUser($bob)->putJson("/api/v1/tasks/{$his->id}/completion", ['completed' => true])->assertOk();

    expect($his->fresh()->completed_at)->not->toBeNull()->and($mine->fresh()->completed_at)->toBeNull();

    // Bob cannot reach my copy's controls; I cannot file his.
    asUser($bob)->postJson("/api/v1/tasks/{$mine->id}/move", ['list_id' => null])->assertForbidden();
    asUser($me)->postJson("/api/v1/tasks/{$his->id}/move", ['list_id' => null])->assertForbidden();
});

test('editing the title or visibility of one copy changes every copy; deleting removes only that one', function () {
    [$me, $bob, $carol] = User::factory()->count(3)->create();
    asUser($me)->postJson('/api/v1/tasks', ['title' => 'Old', 'visibility' => 'public', 'assignee_ids' => [$me->id, $bob->id, $carol->id]])->assertCreated();
    $mine = Task::where('assignee_id', $me->id)->firstOrFail();

    asUser($me)->patchJson("/api/v1/tasks/{$mine->id}", ['title' => 'New', 'visibility' => 'private'])->assertOk();

    expect(Task::pluck('title')->unique()->all())->toBe(['New'])
        ->and(Task::pluck('visibility')->unique()->all())->toBe(['private']);

    $his = Task::where('assignee_id', $bob->id)->firstOrFail();
    asUser($me)->deleteJson("/api/v1/tasks/{$his->id}")->assertNoContent();
    expect(Task::count())->toBe(2)->and(Task::where('assignee_id', $bob->id)->exists())->toBeFalse();
});

test('changing who holds one copy does not touch the others', function () {
    [$me, $bob, $carol] = User::factory()->count(3)->create();
    asUser($me)->postJson('/api/v1/tasks', ['title' => 'T', 'visibility' => 'private', 'assignee_ids' => [$me->id, $bob->id]])->assertCreated();
    $his = Task::where('assignee_id', $bob->id)->firstOrFail();

    asUser($me)->patchJson("/api/v1/tasks/{$his->id}", ['assignee_id' => $carol->id])->assertOk();

    expect(Task::where('assignee_id', $me->id)->count())->toBe(1)
        ->and(Task::where('assignee_id', $carol->id)->count())->toBe(1)
        ->and(Task::where('assignee_id', $bob->id)->count())->toBe(0);
    // A later title edit still reaches the copy that moved to Carol.
    asUser($me)->patchJson('/api/v1/tasks/'.Task::where('assignee_id', $me->id)->firstOrFail()->id, ['title' => 'Z'])->assertOk();
    expect(Task::pluck('title')->unique()->all())->toBe(['Z']);
});

test('a private copy stays private: nobody else sees it, and it names nobody else', function () {
    [$me, $bob, $carol] = User::factory()->count(3)->create();
    asUser($me)->postJson('/api/v1/tasks', ['title' => 'Secret', 'visibility' => 'private', 'assignee_ids' => [$bob->id, $me->id]])->assertCreated();
    $hisId = Task::where('assignee_id', $bob->id)->firstOrFail()->id;
    $mineId = Task::where('assignee_id', $me->id)->firstOrFail()->id;

    asUser($carol)->putJson("/api/v1/tasks/{$hisId}/completion", ['completed' => true])->assertNotFound();
    foreach ([$me, $bob] as $person) {
        asUser($carol)->getJson("/api/v1/users/{$person->id}/tasks")->assertOk()
            ->assertJsonCount(0, 'lists')->assertJsonCount(0, 'unfiled');
    }
    asUser($bob)->putJson("/api/v1/tasks/{$mineId}/completion", ['completed' => true])->assertNotFound();
    asUser($bob)->getJson('/api/v1/tasks/inbox')->assertOk()->assertJsonCount(1)->assertJsonPath('0.id', $hisId);
});

test('assign adds a copy for each new person, skips the ones who already have one, and answers the new copies', function () {
    [$me, $bob, $carol] = User::factory()->count(3)->create();
    $list = TaskList::factory()->create(['user_id' => $me->id]);
    $task = Task::factory()->create(['creator_id' => $me->id, 'assignee_id' => $me->id, 'list_id' => $list->id, 'title' => 'Base', 'visibility' => 'public']);

    $response = asUser($me)->postJson("/api/v1/tasks/{$task->id}/assign", ['assignee_ids' => [$bob->id, $me->id, $carol->id]])->assertOk();

    expect($response->json())->toHaveCount(2)
        ->and(array_column($response->json(), 'title'))->toBe(['Base', 'Base'])
        ->and(Task::count())->toBe(3)
        ->and(Task::pluck('group_id')->unique()->count())->toBe(1)
        ->and(Task::first()->group_id)->not->toBeNull()
        ->and($task->fresh()->list_id)->toBe($list->id);

    // Again: Bob and Carol already have one, nothing is added, and the group stays.
    asUser($me)->postJson("/api/v1/tasks/{$task->id}/assign", ['assignee_ids' => [$bob->id, $carol->id]])->assertOk()->assertExactJson([]);
    expect(Task::count())->toBe(3);
});

test('assign can bring the creator back in, into their first list', function () {
    [$me, $bob] = User::factory()->count(2)->create();
    $task = Task::factory()->create(['creator_id' => $me->id, 'assignee_id' => $bob->id, 'title' => 'Given']);

    $response = asUser($me)->postJson("/api/v1/tasks/{$task->id}/assign", ['assignee_ids' => [$me->id]])->assertOk();

    $list = TaskList::where('user_id', $me->id)->firstOrFail();
    expect($response->json('0.list_id'))->toBe($list->id)
        ->and($response->json('0.assignee.id'))->toBe($me->id)
        ->and(Task::where('assignee_id', $bob->id)->count())->toBe(1);
});

test('assign is the creator\'s: a holder gets 403, a stranger to a private task gets 404', function () {
    [$me, $bob, $carol] = User::factory()->count(3)->create();
    $task = Task::factory()->create(['creator_id' => $me->id, 'assignee_id' => $bob->id]);

    asUser($bob)->postJson("/api/v1/tasks/{$task->id}/assign", ['assignee_ids' => [$carol->id]])->assertForbidden();
    asUser($carol)->postJson("/api/v1/tasks/{$task->id}/assign", ['assignee_ids' => [$carol->id]])->assertNotFound();
    expect(Task::count())->toBe(1);
});

test('assign refuses everything when one person cannot receive it', function () {
    [$me, $bob] = User::factory()->count(2)->create();
    $banned = User::factory()->create(['banned_at' => now()]);
    $task = Task::factory()->create(['creator_id' => $me->id, 'assignee_id' => $bob->id]);

    asUser($me)->postJson("/api/v1/tasks/{$task->id}/assign", ['assignee_ids' => [$me->id, $banned->id]])
        ->assertUnprocessable()->assertJson(['error' => 'invalid_assignee']);
    asUser($me)->postJson("/api/v1/tasks/{$task->id}/assign", ['assignee_ids' => []])->assertUnprocessable();
    asUser($me)->postJson("/api/v1/tasks/{$task->id}/assign", ['assignee_ids' => [$me->id], 'list_id' => TaskList::factory()->create()->id])
        ->assertUnprocessable();

    expect(Task::count())->toBe(1)->and($task->fresh()->group_id)->toBeNull();
});

test('every holder and the creator are told once per copy', function () {
    Event::fake([TaskChanged::class]);
    [$me, $bob, $carol] = User::factory()->count(3)->create();

    asUser($me)->postJson('/api/v1/tasks', ['title' => 'T', 'visibility' => 'private', 'assignee_ids' => [$bob->id, $carol->id]])->assertCreated();

    $told = Event::dispatched(TaskChanged::class)->map(fn ($call) => [$call[0]->taskId, $call[0]->userId])->all();
    $byTask = collect($told)->groupBy(0)->map(fn ($rows) => $rows->pluck(1)->sort()->values()->all());
    expect($byTask)->toHaveCount(2)
        ->and($byTask->flatten()->countBy()->all())->toBe([$me->id => 2, $bob->id => 1, $carol->id => 1]);
});

test('the creator sees every other copy in "assigned by me", with its own state', function () {
    [$me, $bob, $carol] = User::factory()->count(3)->create();
    asUser($me)->postJson('/api/v1/tasks', ['title' => 'T', 'visibility' => 'private', 'assignee_ids' => [$me->id, $bob->id, $carol->id]])->assertCreated();
    asUser($bob)->putJson('/api/v1/tasks/'.Task::where('assignee_id', $bob->id)->firstOrFail()->id.'/completion', ['completed' => true])->assertOk();

    $byMe = asUser($me)->getJson('/api/v1/tasks/by-me')->assertOk();

    expect($byMe->json())->toHaveCount(2);
    $states = collect($byMe->json())->mapWithKeys(fn ($t) => [$t['assignee']['id'] => $t['completed']])->all();
    expect($states)->toBe([$bob->id => true, $carol->id => false]);
});

test('a copy added later follows the group: a later edit reaches it, and its title is the current one', function () {
    [$me, $bob, $carol] = User::factory()->count(3)->create();
    asUser($me)->postJson('/api/v1/tasks', ['title' => 'First', 'visibility' => 'public', 'assignee_ids' => [$me->id, $bob->id]])->assertCreated();
    $mine = Task::where('assignee_id', $me->id)->firstOrFail();
    asUser($me)->patchJson("/api/v1/tasks/{$mine->id}", ['title' => 'Second'])->assertOk();

    asUser($me)->postJson('/api/v1/tasks/'.Task::where('assignee_id', $bob->id)->firstOrFail()->id.'/assign', ['assignee_ids' => [$carol->id]])->assertOk();
    expect(Task::where('assignee_id', $carol->id)->firstOrFail()->title)->toBe('Second');

    asUser($me)->patchJson("/api/v1/tasks/{$mine->id}", ['visibility' => 'private'])->assertOk();
    expect(Task::pluck('visibility')->unique()->all())->toBe(['private'])->and(Task::pluck('group_id')->unique()->count())->toBe(1);
});
