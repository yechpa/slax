<?php

use App\Events\MessageCreated;
use App\Models\Channel;
use App\Models\User;
use App\Models\Workspace;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Broadcasting\BroadcastManager;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Database\QueryException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

/** @param list<int|string|null> $ids */
function openDm(User $caller, array $ids): TestResponse
{
    return asUser($caller)->postJson('/api/v1/dms', ['user_ids' => $ids]);
}

/** @return list<int> */
function memberIds(Channel $channel): array
{
    return $channel->members()->orderBy('users.id')->pluck('users.id')->all();
}

test('creating_dm_twice_returns_same_channel', function () {
    [$alice, $bob] = User::factory()->count(2)->create();

    $first = openDm($alice, [$bob->id])->assertCreated()
        ->assertJson(['kind' => 'dm', 'name' => null, 'topic' => null, 'is_member' => true]);
    $second = openDm($alice, [$bob->id])->assertOk();

    expect($second->json('id'))->toBe($first->json('id'))
        ->and(Channel::whereIn('kind', [Channel::KIND_DM, Channel::KIND_GROUP_DM])->count())->toBe(1);

    $channel = Channel::findOrFail($first->json('id'));
    expect($channel->workspace_id)->toBe(Workspace::default()->id)
        ->and(memberIds($channel))->toBe([$alice->id, $bob->id])
        ->and($channel->members->pluck('pivot.role')->unique()->all())->toBe(['member']);

    // Bob opening the conversation from his side lands on the very same channel.
    expect(openDm($bob, [$alice->id])->assertOk()->json('id'))->toBe($first->json('id'));
});

test('group_dm_over_8_rejected', function () {
    $caller = User::factory()->create();
    $others = User::factory()->count(8)->create()->pluck('id')->all();

    // 1 + 8 = 9 people.
    openDm($caller, $others)->assertStatus(422)->assertExactJson(['error' => 'invalid_participant_count']);
    // 1 + 7 = 8 people is the limit.
    $ok = openDm($caller, array_slice($others, 0, 7))->assertCreated()->assertJson(['kind' => 'group_dm']);

    expect(Channel::findOrFail($ok->json('id'))->members()->count())->toBe(8)
        ->and(Channel::whereIn('kind', [Channel::KIND_DM, Channel::KIND_GROUP_DM])->count())->toBe(1);
});

test('user_ids holds 8 entries at most, duplicates included, before anything is looked up', function () {
    $caller = User::factory()->create();
    $bob = User::factory()->create();

    // Nine times the same person would make a set of two: still refused, as too many.
    openDm($caller, array_fill(0, 9, $bob->id))->assertStatus(422)->assertExactJson(['error' => 'invalid_participant_count']);
    DB::enableQueryLog();
    openDm($caller, range(1, 5000))->assertStatus(422)->assertExactJson(['error' => 'invalid_participant_count']);
    expect(collect(DB::getQueryLog())->pluck('query')->filter(fn (string $sql) => str_contains($sql, '"users"'))->count())->toBeLessThanOrEqual(1);
    // Eight entries (the caller among them) are fine.
    openDm($caller, [...array_fill(0, 7, $bob->id), $caller->id])->assertCreated();
});

test('a conversation of 8 people with the longest ids has room for its key', function () {
    $ids = collect(range(1, 8))->map(fn (int $i) => 9_100_000_000_000_000_000 + $i);
    $users = $ids->map(fn (int $id) => User::factory()->create(['id' => $id]));

    openDm($users[0], $ids->slice(1)->values()->all())->assertCreated()->assertJson(['kind' => 'group_dm']);
    expect(Channel::where('kind', Channel::KIND_GROUP_DM)->sole()->dm_key)->toBe('dm:'.$ids->implode(','));
    // The same set again: the existing one.
    openDm($users[3], $ids->reverse()->values()->all())->assertOk();
});

test('cannot_dm_banned_user', function () {
    $caller = User::factory()->create();
    $friend = User::factory()->create();
    $banned = User::factory()->banned()->create();

    openDm($caller, [$banned->id])->assertStatus(422)->assertExactJson(['error' => 'invalid_participants']);
    // One bad apple in a group spoils it, and the answer does not say which.
    openDm($caller, [$friend->id, $banned->id])->assertStatus(422)->assertExactJson(['error' => 'invalid_participants']);
    // An unknown id gets the same answer as a banned one.
    openDm($caller, [$friend->id, 999999])->assertStatus(422)->assertExactJson(['error' => 'invalid_participants']);

    expect(Channel::whereIn('kind', [Channel::KIND_DM, Channel::KIND_GROUP_DM])->count())->toBe(0);
});

test('dm_is_invisible_to_outsiders', function () {
    [$alice, $bob, $mallory] = User::factory()->count(3)->create();
    $id = openDm($alice, [$bob->id])->assertCreated()->json('id');

    asUser($mallory)->getJson("/api/v1/channels/{$id}")->assertNotFound();
    asUser($mallory)->getJson("/api/v1/channels/{$id}/messages")->assertNotFound();
    asUser($mallory)->postJson("/api/v1/channels/{$id}/messages", ['body' => 'hi', 'client_id' => (string) Str::uuid()])->assertNotFound();
    asUser($mallory)->postJson("/api/v1/channels/{$id}/join")->assertNotFound();
    expect(asUser($mallory)->getJson('/api/v1/channels')->assertOk()->json('*.id'))->not->toContain($id);

    asUser($bob)->getJson("/api/v1/channels/{$id}")->assertOk()->assertJson(['id' => $id, 'kind' => 'dm']);
});

test('dm membership is a set: order of ids and who opens it do not matter', function () {
    [$a, $b, $c] = User::factory()->count(3)->create();

    $id = openDm($a, [$b->id, $c->id])->assertCreated()->assertJson(['kind' => 'group_dm'])->json('id');

    expect(openDm($a, [$c->id, $b->id])->assertOk()->json('id'))->toBe($id)
        ->and(openDm($c, [$a->id, $b->id])->assertOk()->json('id'))->toBe($id)
        ->and(openDm($b, [$c->id, $a->id])->assertOk()->json('id'))->toBe($id);

    // A different set is a different conversation, even with overlapping people.
    $other = openDm($a, [$b->id])->assertCreated()->json('id');
    expect($other)->not->toBe($id);
    $d = User::factory()->create();
    expect(openDm($a, [$b->id, $c->id, $d->id])->assertCreated()->json('id'))->not->toBe($id);
});

test('a dm with yourself or an empty list is rejected', function (array $ids) {
    $caller = User::factory()->create();
    $ids = array_map(fn ($id) => $id === 'self' ? $caller->id : $id, $ids);

    openDm($caller, $ids)->assertStatus(422)->assertExactJson(['error' => 'invalid_participant_count']);

    expect(Channel::whereIn('kind', [Channel::KIND_DM, Channel::KIND_GROUP_DM])->count())->toBe(0);
})->with([
    'only myself' => [['self']],
    'myself twice' => [['self', 'self']],
    'empty' => [[]],
]);

test('duplicates and the caller are ignored in user_ids', function () {
    [$alice, $bob] = User::factory()->count(2)->create();

    $dm = openDm($alice, [$bob->id, $bob->id, $alice->id, (string) $bob->id])->assertCreated()->assertJson(['kind' => 'dm']);

    expect(memberIds(Channel::findOrFail($dm->json('id'))))->toBe([$alice->id, $bob->id])
        ->and(openDm($alice, [$bob->id])->assertOk()->json('id'))->toBe($dm->json('id'));
});

test('malformed user_ids are validation errors', function (mixed $payload) {
    $caller = User::factory()->create();

    asUser($caller)->postJson('/api/v1/dms', $payload)->assertStatus(422);
})->with([
    'missing' => [[]],
    'not an array' => [['user_ids' => 5]],
    'non integer' => [['user_ids' => ['abc']]],
    'null element' => [['user_ids' => [null]]],
    'nested' => [['user_ids' => [[1]]]],
    'negative' => [['user_ids' => [-3]]],
]);

test('dms require a session', function () {
    test()->withHeaders(['Referer' => 'http://localhost/'])->postJson('/api/v1/dms', ['user_ids' => [1]])->assertUnauthorized();
});

test('a banned caller cannot open dms', function () {
    $caller = User::factory()->banned()->create();
    $bob = User::factory()->create();

    openDm($caller, [$bob->id])->assertForbidden()->assertExactJson(['error' => 'account_banned']);
});

test('dm and group appear in the callers channel list but not in others', function () {
    [$alice, $bob, $carol, $dave] = User::factory()->count(4)->create();
    $dm = openDm($alice, [$bob->id])->assertCreated()->json('id');
    $group = openDm($alice, [$bob->id, $carol->id])->assertCreated()->json('id');

    $rows = collect(asUser($alice)->getJson('/api/v1/channels')->assertOk()->json());
    expect($rows->pluck('id'))->toContain($dm, $group);

    $dmRow = $rows->firstWhere('id', $dm);
    expect($dmRow)->toMatchArray(['kind' => 'dm', 'name' => null, 'is_member' => true]);
    expect($dmRow['members'])->toBe(collect([$alice, $bob])->sortBy('id')->values()
        ->map(fn (User $u) => ['id' => $u->id, 'name' => $u->name, 'avatar_url' => $u->avatar_url])->all());
    $groupRow = $rows->firstWhere('id', $group);
    expect($groupRow['kind'])->toBe('group_dm')
        ->and(array_column($groupRow['members'], 'id'))->toBe([$alice->id, $bob->id, $carol->id]);

    // Rooms keep their shape: no members key.
    $general = $rows->firstWhere('name', 'general');
    expect($general)->not->toHaveKey('members');

    // Carol is only in the group; Dave sees neither.
    $carolIds = asUser($carol)->getJson('/api/v1/channels')->json('*.id');
    expect($carolIds)->toContain($group)->not->toContain($dm);
    expect(asUser($dave)->getJson('/api/v1/channels')->json('*.id'))->not->toContain($dm, $group);

    // The single-channel endpoint carries the members too.
    asUser($bob)->getJson("/api/v1/channels/{$dm}")->assertOk()->assertJsonCount(2, 'members');
});

test('a banned participant is left out of a conversation, like everywhere else, until the ban is lifted', function () {
    [$alice, $bob, $carol] = User::factory()->count(3)->create();
    $group = openDm($alice, [$bob->id, $carol->id])->assertCreated()->json('id');
    $carol->forceFill(['banned_at' => now()])->save();

    $row = collect(asUser($alice)->getJson('/api/v1/channels')->assertOk()->json())->firstWhere('id', $group);
    expect(array_column($row['members'], 'id'))->toBe([$alice->id, $bob->id])
        ->and($row['member_count'])->toBe(2);
    $shown = asUser($bob)->getJson("/api/v1/channels/{$group}")->assertOk();
    expect(array_column($shown->json('members'), 'id'))->toBe([$alice->id, $bob->id])
        ->and($shown->json('member_count'))->toBe(2);
    // As the member list says (it always left banned accounts out).
    expect(asUser($alice)->getJson("/api/v1/channels/{$group}/members")->json('*.id'))->toEqualCanonicalizing([$alice->id, $bob->id]);
    expect($shown->getContent())->not->toContain($carol->name);

    // Ban lifted: back in the conversation.
    $carol->forceFill(['banned_at' => null])->save();
    $row = collect(asUser($alice)->getJson('/api/v1/channels')->json())->firstWhere('id', $group);
    expect(array_column($row['members'], 'id'))->toBe([$alice->id, $bob->id, $carol->id])
        ->and($row['member_count'])->toBe(3);
});

test('losing a creation race returns the winners channel', function () {
    [$alice, $bob] = User::factory()->count(2)->create();
    $winner = null;

    // Right after the first lookup misses, a concurrent request commits the same conversation.
    DB::listen(function (QueryExecuted $query) use (&$winner, $alice, $bob) {
        if ($winner === null && str_contains($query->sql, 'dm_key') && str_starts_with(strtolower($query->sql), 'select')) {
            $winner = Channel::create(['workspace_id' => Workspace::default()->id, 'kind' => Channel::KIND_DM, 'dm_key' => "dm:{$alice->id},{$bob->id}", 'created_by' => $bob->id]);
            $winner->addMember($alice);
            $winner->addMember($bob);
        }
    });

    $response = openDm($alice, [$bob->id])->assertOk();

    expect($winner)->not->toBeNull()
        ->and($response->json('id'))->toBe($winner->id)
        ->and(Channel::where('kind', Channel::KIND_DM)->count())->toBe(1)
        ->and(memberIds($winner))->toBe([$alice->id, $bob->id]);
});

test('the database refuses two channels for the same member set', function () {
    $insert = fn () => DB::table('channels')->insert([
        'workspace_id' => Workspace::default()->id, 'kind' => 'dm', 'dm_key' => 'dm:1,2', 'created_at' => now(), 'updated_at' => now(),
    ]);
    $insert();

    expect($insert)->toThrow(UniqueConstraintViolationException::class);
});

test('rooms and dms differ by dm_key presence in the schema', function () {
    $now = now();
    $row = ['workspace_id' => Workspace::default()->id, 'created_at' => $now, 'updated_at' => $now];

    foreach ([
        ['kind' => 'public', 'name' => 'x', 'dm_key' => 'dm:1,2'],
        ['kind' => 'dm'],
    ] as $bad) {
        DB::statement('SAVEPOINT s');
        try {
            DB::table('channels')->insert($row + $bad);
            $accepted = true;
        } catch (QueryException) {
            $accepted = false;
        }
        DB::statement('ROLLBACK TO SAVEPOINT s');
        expect($accepted)->toBeFalse();
    }
});

test('dms are not manageable rooms', function () {
    [$alice, $bob, $carol] = User::factory()->count(3)->create();
    $id = openDm($alice, [$bob->id])->assertCreated()->json('id');

    asUser($alice)->postJson("/api/v1/channels/{$id}/leave")->assertForbidden();
    asUser($alice)->postJson("/api/v1/channels/{$id}/join")->assertForbidden();
    asUser($alice)->postJson("/api/v1/channels/{$id}/members", ['user_id' => $carol->id])->assertForbidden();
    asUser($alice)->deleteJson("/api/v1/channels/{$id}/members/{$bob->id}")->assertForbidden();

    expect(Channel::findOrFail($id)->members()->count())->toBe(2);
});

test('a message in a dm is delivered to its members only', function () {
    Event::fake([MessageCreated::class]);
    [$alice, $bob, $mallory] = User::factory()->count(3)->create();
    $id = openDm($alice, [$bob->id])->assertCreated()->json('id');

    $sent = asUser($alice)->postJson("/api/v1/channels/{$id}/messages", ['body' => 'psst', 'client_id' => (string) Str::uuid()])->assertCreated();
    asUser($bob)->getJson("/api/v1/channels/{$id}/messages")->assertOk()->assertJsonPath('data.0.body', 'psst');

    Event::assertDispatchedTimes(MessageCreated::class, 1);
    $event = Event::dispatched(MessageCreated::class)->first()[0];
    expect($event->broadcastOn()[0]->name)->toBe("private-channel.{$id}")
        ->and($event->broadcastWith())->toBe($sent->json());

    // The private channel only lets members subscribe (checked on the real Reverb driver, as in RealtimeTest).
    config(['broadcasting.default' => 'reverb', 'broadcasting.connections.reverb' => [
        'driver' => 'reverb', 'key' => 'test-key', 'secret' => 'test-secret', 'app_id' => 'test-app',
        'options' => ['host' => 'reverb.test', 'port' => 8080, 'scheme' => 'http', 'useTLS' => false],
    ]]);
    app(BroadcastManager::class)->purge('reverb');
    require base_path('routes/channels.php');
    $auth = fn (User $user) => asUser($user)->postJson('/broadcasting/auth', ['socket_id' => '1234.5678', 'channel_name' => "private-channel.{$id}"]);
    $auth($alice)->assertOk();
    $auth($bob)->assertOk();
    $auth($mallory)->assertForbidden();
});
