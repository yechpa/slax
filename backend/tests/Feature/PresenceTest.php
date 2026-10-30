<?php

use App\Models\User;
use App\Services\PresenceService;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Redis\Events\CommandExecuted;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Redis;

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
