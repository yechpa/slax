<?php

use App\Models\User;
use App\Models\Workspace;
use App\Services\PresenceService;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Redis\Events\CommandExecuted;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Redis;
use Tests\Support\WebSocketClient;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);

    // phpunit.xml points Redis at database 15; never flush anything else.
    expect((int) config('database.redis.default.database'))->toBe(15);
    Redis::connection()->flushdb();
});

function presence(): PresenceService
{
    return app(PresenceService::class);
}

function ban(User $user): void
{
    $user->forceFill(['banned_at' => now()])->save();
}

/** Same-origin heartbeat call, as the SPA sends it every 25 seconds. */
function heartbeat(User $user, mixed $active = true)
{
    return asUser($user)->postJson('/api/v1/presence/heartbeat', ['active' => $active]);
}

test('online_after_heartbeat', function () {
    $user = User::factory()->create();

    expect(presence()->stateOf($user->id))->toBe('offline');

    presence()->heartbeat($user->id, true);

    expect(presence()->stateOf($user->id))->toBe('online');
    // The key is refreshed by every ping and dies 60 seconds after the last one.
    expect(Redis::connection()->ttl("presence:{$user->id}"))->toBeBetween(55, 60);
});

test('offline_after_ttl_expiry', function () {
    $user = User::factory()->create();
    presence()->heartbeat($user->id, true);

    // Two pings missed is more than the 25 s cadence allows, but one is not.
    $this->travel(59)->seconds();
    expect(presence()->stateOf($user->id))->toBe('online');

    $this->travel(2)->seconds();
    expect(presence()->stateOf($user->id))->toBe('offline');

    // A new ping brings the user back.
    presence()->heartbeat($user->id, true);
    expect(presence()->stateOf($user->id))->toBe('online');
});

test('every heartbeat refreshes the time to live', function () {
    $user = User::factory()->create();

    foreach (range(1, 6) as $ignored) {
        presence()->heartbeat($user->id, true);
        $this->travel(25)->seconds();
        expect(presence()->stateOf($user->id))->toBe('online');
    }
});

test('away_after_5_minutes_inactive', function () {
    $user = User::factory()->create();
    presence()->heartbeat($user->id, true);

    // The tab keeps pinging every 25 s but reports no interaction.
    foreach (range(1, 11) as $ignored) {
        $this->travel(25)->seconds();
        presence()->heartbeat($user->id, false);
    }
    // 275 s since the last interaction.
    expect(presence()->stateOf($user->id))->toBe('online');

    $this->travel(24)->seconds();
    presence()->heartbeat($user->id, false);
    expect(presence()->stateOf($user->id))->toBe('online'); // 299 s

    $this->travel(1)->seconds();
    presence()->heartbeat($user->id, false);
    expect(presence()->stateOf($user->id))->toBe('away'); // 300 s

    // Interacting again brings the user back online.
    presence()->heartbeat($user->id, true);
    expect(presence()->stateOf($user->id))->toBe('online');
});

test('a user who never interacted is away, and goes offline when pings stop', function () {
    $user = User::factory()->create();

    presence()->heartbeat($user->id, false);
    expect(presence()->stateOf($user->id))->toBe('away');

    $this->travel(61)->seconds();
    expect(presence()->stateOf($user->id))->toBe('offline');
});

test('banned_user_shown_offline', function () {
    $user = User::factory()->create();
    $other = User::factory()->create();
    presence()->heartbeat($user->id, true);
    presence()->heartbeat($other->id, true);
    expect(presence()->stateOf($user->id))->toBe('online');

    ban($user);

    // Redis still holds a live key; the ban wins.
    expect(Redis::connection()->exists("presence:{$user->id}"))->toBe(1)
        ->and(presence()->stateOf($user->id))->toBe('offline')
        ->and(presence()->statesOf([$user->id, $other->id]))->toBe([$user->id => 'offline', $other->id => 'online']);

    asUser($other)->getJson("/api/v1/presence?user_ids[]={$user->id}&user_ids[]={$other->id}")
        ->assertOk()->assertExactJson([(string) $user->id => 'offline', (string) $other->id => 'online']);
});

test('statesOf answers for many users in a single Redis round trip', function () {
    $users = User::factory()->count(30)->create();
    $users->each(fn ($user, $i) => presence()->heartbeat($user->id, $i % 2 === 0));
    ban($users[0]);

    $commands = [];
    Redis::enableEvents();
    Redis::purge();
    Event::listen(CommandExecuted::class, function (CommandExecuted $event) use (&$commands) {
        $commands[] = $event->command;
    });

    $states = presence()->statesOf($users->pluck('id')->all());

    Redis::disableEvents();
    Redis::purge();

    expect($commands)->toHaveCount(1)
        ->and($states)->toHaveCount(30)
        ->and($states[$users[0]->id])->toBe('offline')
        ->and($states[$users[1]->id])->toBe('away')
        ->and($states[$users[2]->id])->toBe('online');
});

test('statesOf of nobody costs nothing', function () {
    expect(presence()->statesOf([]))->toBe([]);
});

test('the heartbeat endpoint stores the state of the caller', function () {
    $user = User::factory()->create();

    heartbeat($user, true)->assertNoContent();
    expect(presence()->stateOf($user->id))->toBe('online');

    $idle = User::factory()->create();
    heartbeat($idle, false)->assertNoContent();
    expect(presence()->stateOf($idle->id))->toBe('away');
});

test('the heartbeat endpoint needs a signed-in, non-banned user and a boolean', function () {
    $user = User::factory()->create();

    test()->withHeaders(['Referer' => 'http://localhost/'])
        ->postJson('/api/v1/presence/heartbeat', ['active' => true])->assertUnauthorized();

    heartbeat($user, null)->assertUnprocessable()->assertJsonValidationErrors('active');
    heartbeat($user, 'maybe')->assertUnprocessable()->assertJsonValidationErrors('active');
    asUser($user)->postJson('/api/v1/presence/heartbeat')->assertUnprocessable()->assertJsonValidationErrors('active');
    expect(presence()->stateOf($user->id))->toBe('offline');

    ban($user);
    heartbeat($user, true)->assertForbidden()->assertExactJson(['error' => 'account_banned']);
    expect(Redis::connection()->exists("presence:{$user->id}"))->toBe(0);
});

test('heartbeats are rate limited per user, with room for several tabs', function () {
    $user = User::factory()->create();
    $other = User::factory()->create();

    // One tab pings 2.4 times a minute: four back-to-back pings are nothing.
    foreach (range(1, 4) as $ignored) {
        heartbeat($user, true)->assertNoContent();
    }

    $limited = null;
    foreach (range(5, 40) as $attempt) {
        if (heartbeat($user, true)->status() === 429) {
            $limited = $attempt;
            break;
        }
    }

    // Eight tabs' worth of pings pass; a flood does not.
    expect($limited)->toBeBetween(20, 25);
    // Another user is unaffected.
    heartbeat($other, true)->assertNoContent();
});

test('the bulk endpoint returns the state of up to 200 users', function () {
    $viewer = User::factory()->create();
    $online = User::factory()->create();
    $away = User::factory()->create();
    $gone = User::factory()->create();
    presence()->heartbeat($online->id, true);
    presence()->heartbeat($away->id, false);

    $query = http_build_query(['user_ids' => [$online->id, $away->id, $gone->id]]);
    asUser($viewer)->getJson("/api/v1/presence?{$query}")->assertOk()->assertExactJson([
        (string) $online->id => 'online',
        (string) $away->id => 'away',
        (string) $gone->id => 'offline',
    ]);
});

test('the bulk endpoint omits unknown ids and repeats nothing', function () {
    $viewer = User::factory()->create();
    presence()->heartbeat($viewer->id, true);
    $unknown = $viewer->id + 1000;

    $query = http_build_query(['user_ids' => [$viewer->id, $unknown, $viewer->id]]);
    asUser($viewer)->getJson("/api/v1/presence?{$query}")->assertOk()
        ->assertExactJson([(string) $viewer->id => 'online']);

    // Nobody known at all: an empty JSON object, not an empty array.
    $response = asUser($viewer)->get('/api/v1/presence?user_ids[]='.$unknown, ['Accept' => 'application/json']);
    expect($response->getContent())->toBe('{}');
});

test('the bulk endpoint caps the request at 200 ids', function () {
    $viewer = User::factory()->create();
    $ask = fn (int $count) => asUser($viewer)->getJson('/api/v1/presence?'.http_build_query([
        'user_ids' => range($viewer->id, $viewer->id + $count - 1),
    ]));

    $ask(200)->assertOk()->assertExactJson([(string) $viewer->id => 'offline']);
    $ask(201)->assertUnprocessable()->assertJsonValidationErrors('user_ids');
});

test('the bulk endpoint validates its input and needs a signed-in user', function () {
    $viewer = User::factory()->create();

    test()->withHeaders(['Referer' => 'http://localhost/'])
        ->getJson('/api/v1/presence?user_ids[]=1')->assertUnauthorized();

    asUser($viewer)->getJson('/api/v1/presence')->assertUnprocessable()->assertJsonValidationErrors('user_ids');
    asUser($viewer)->getJson('/api/v1/presence?user_ids=5')->assertUnprocessable()->assertJsonValidationErrors('user_ids');
    asUser($viewer)->getJson('/api/v1/presence?user_ids[]=abc')->assertUnprocessable()->assertJsonValidationErrors('user_ids.0');
    asUser($viewer)->getJson('/api/v1/presence?user_ids[]=0')->assertUnprocessable()->assertJsonValidationErrors('user_ids.0');
    asUser($viewer)->getJson('/api/v1/presence?user_ids[]=99999999999999999999')->assertUnprocessable();

    ban($viewer);
    asUser($viewer)->getJson("/api/v1/presence?user_ids[]={$viewer->id}")->assertForbidden();
});

/** The broadcaster that signs channel authorizations, with fixed credentials. */
function usePresenceBroadcaster(): void
{
    config(['broadcasting.connections.reverb' => [
        'driver' => 'reverb',
        'key' => 'test-key',
        'secret' => 'test-secret',
        'app_id' => 'test-app',
        'options' => ['host' => 'reverb.test', 'port' => 8080, 'scheme' => 'http', 'useTLS' => false],
    ]]);
    useReverbDriver();
}

function workspaceChannel(?int $id = null): string
{
    return 'presence-workspace.'.($id ?? Workspace::default()->id);
}

test('any signed-in user is authorized on the workspace presence channel', function () {
    usePresenceBroadcaster();
    $user = User::factory()->create(['name' => 'Dana', 'avatar_url' => 'https://example.test/dana.png', 'email' => 'dana@example.test']);

    $response = authorizeChannelName($user, workspaceChannel())->assertOk();
    $auth = $response->json();
    $data = json_decode($auth['channel_data'], true);

    expect($data)->toBe([
        'user_id' => (string) $user->id,
        'user_info' => ['id' => $user->id, 'name' => 'Dana', 'avatar_url' => 'https://example.test/dana.png'],
    ]);
    // Everybody in the workspace sees the member list: the e-mail address never goes into it.
    expect($response->getContent())->not->toContain('dana@example.test')->not->toContain('email');
    $signature = hash_hmac('sha256', '1234.5678:'.workspaceChannel().':'.$auth['channel_data'], 'test-secret');
    expect($auth['auth'])->toBe("test-key:{$signature}");
});

test('the workspace presence channel refuses guests, banned users and other workspaces', function () {
    usePresenceBroadcaster();
    $user = User::factory()->create();

    // Guests first (acting as a user sticks for the rest of the test).
    test()->withHeaders(['Referer' => 'http://localhost/'])
        ->postJson('/broadcasting/auth', ['socket_id' => '1.2', 'channel_name' => workspaceChannel()])
        ->assertForbidden();

    authorizeChannelName($user, workspaceChannel(Workspace::default()->id + 1))->assertForbidden();
    authorizeChannelName($user, 'presence-workspace.abc')->assertForbidden();
    authorizeChannelName($user, 'presence-workspace.99999999999999999999')->assertForbidden();

    ban($user);
    authorizeChannelName($user, workspaceChannel())->assertForbidden()->assertExactJson(['error' => 'account_banned']);
});

/*
 * End-to-end against the Reverb server of the dev stack (real WebSocket).
 * Excluded from the default run (phpunit.xml); `make test-reverb` starts Reverb and runs it.
 */

/** @return array{WebSocketClient, string} a connected socket and its id */
function openSocket(): array
{
    useReverbDriver();
    $key = config('broadcasting.connections.reverb.key');
    $socket = WebSocketClient::connect(
        config('broadcasting.connections.reverb.options.host'),
        (int) config('broadcasting.connections.reverb.options.port'),
        "/app/{$key}?protocol=7&client=slax-e2e&version=1.0",
    );

    return [$socket, json_decode($socket->waitFor('pusher:connection_established')['data'], true)['socket_id']];
}

/** A new socket subscribed to $channelName with a fresh authorization of $user. */
function subscribeSocket(User $user, string $channelName): WebSocketClient
{
    [$socket, $socketId] = openSocket();
    $auth = authorizeChannelName($user, $channelName, $socketId)->assertOk()->json();
    $socket->send(['event' => 'pusher:subscribe', 'data' => ['channel' => $channelName] + $auth]);
    expect($socket->waitFor('pusher_internal:subscription_succeeded'))->not->toBeNull();

    return $socket;
}

/** What pusher-js sends for `channel.whisper('typing', {...})`. */
function whisperTyping(WebSocketClient $socket, string $channelName): void
{
    $socket->send(['event' => 'client-typing', 'channel' => $channelName, 'data' => ['typing' => true]]);
}

test('reverb_e2e_typing_whispers_reach_other_members_only', function () {
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $outsider = User::factory()->create();
    $channel = privateChannel($owner);
    $channel->members()->attach($member->id);
    $name = "private-channel.{$channel->id}";

    $ownerSocket = subscribeSocket($owner, $name);
    $memberSocket = subscribeSocket($member, $name);

    // Member A types: member B hears it, tagged with A's id by the server (not by the client).
    whisperTyping($ownerSocket, $name);
    $heard = $memberSocket->waitFor('client-typing');
    expect($heard)->not->toBeNull()
        ->and($heard['channel'])->toBe($name)
        ->and($heard['data'])->toBe(['typing' => true])
        ->and((int) $heard['user_id'])->toBe($owner->id);
    // The sender does not get its own whisper back.
    expect($ownerSocket->waitFor('client-typing', 1))->toBeNull();

    // A client cannot pretend to be somebody else.
    $ownerSocket->send(['event' => 'client-typing', 'channel' => $name, 'data' => ['typing' => true], 'user_id' => (string) $member->id]);
    expect((int) $memberSocket->waitFor('client-typing')['user_id'])->toBe($owner->id);

    // An outsider is refused by the authorization endpoint and, subscribed to nothing, cannot whisper in.
    [$outsiderSocket, $socketId] = openSocket();
    authorizeChannelName($outsider, $name, $socketId)->assertForbidden();
    whisperTyping($outsiderSocket, $name);
    $error = $outsiderSocket->waitFor('pusher:error');
    expect($error)->not->toBeNull()->and(json_decode($error['data'], true)['code'])->toBe(4009);
    expect($memberSocket->waitFor('client-typing', 1.5))->toBeNull()
        ->and($ownerSocket->waitFor('client-typing', 0.5))->toBeNull();

    // Neither can a member of another channel, even though it is subscribed to something.
    $elsewhere = privateChannel($outsider, 'elsewhere');
    $elsewhereSocket = subscribeSocket($outsider, "private-channel.{$elsewhere->id}");
    whisperTyping($elsewhereSocket, $name);
    expect(json_decode($elsewhereSocket->waitFor('pusher:error')['data'], true)['code'])->toBe(4009);
    expect($memberSocket->waitFor('client-typing', 1))->toBeNull();

    // Removing the member cuts their socket: they hear nothing any more...
    asUser($owner)->deleteJson("/api/v1/channels/{$channel->id}/members/{$member->id}")->assertNoContent();
    expect($memberSocket->waitFor('client-typing', 3))->toBeNull()->and($memberSocket->isClosed())->toBeTrue();
    whisperTyping($ownerSocket, $name);
    expect($memberSocket->waitFor('client-typing', 1))->toBeNull();

    // ...and cannot get back in or whisper from a new connection.
    [$again, $againId] = openSocket();
    authorizeChannelName($member, $name, $againId)->assertForbidden();
    whisperTyping($again, $name);
    expect(json_decode($again->waitFor('pusher:error')['data'], true)['code'])->toBe(4009);
    expect($ownerSocket->waitFor('client-typing', 1))->toBeNull();

    foreach ([$ownerSocket, $outsiderSocket, $elsewhereSocket, $again] as $socket) {
        $socket->close();
    }
})->group('reverb-e2e')->skip(! getenv('REVERB_E2E'), 'Opt-in: set REVERB_E2E=1 with the dev Reverb server running.');

test('reverb_e2e_presence_channel_announces_joins_and_leaves_without_emails', function () {
    $dana = User::factory()->create(['name' => 'Dana', 'email' => 'dana@example.test']);
    $eli = User::factory()->create(['name' => 'Eli', 'email' => 'eli@example.test']);
    $name = workspaceChannel();

    $danaSocket = subscribeSocket($dana, $name);
    $eliSocket = subscribeSocket($eli, $name);

    $joined = $danaSocket->waitFor('pusher_internal:member_added');
    expect($joined)->not->toBeNull();
    $member = json_decode($joined['data'], true);
    expect((int) $member['user_id'])->toBe($eli->id)
        ->and($member['user_info']['name'])->toBe('Eli')
        ->and($joined['data'])->not->toContain('eli@example.test');

    $eliSocket->close();
    $left = $danaSocket->waitFor('pusher_internal:member_removed');
    expect($left)->not->toBeNull()
        ->and((int) json_decode($left['data'], true)['user_id'])->toBe($eli->id);

    $danaSocket->close();
})->group('reverb-e2e')->skip(! getenv('REVERB_E2E'), 'Opt-in: set REVERB_E2E=1 with the dev Reverb server running.');
