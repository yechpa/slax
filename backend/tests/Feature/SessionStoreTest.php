<?php

use App\Contracts\IdentityProvider;
use App\Models\User;
use App\Services\Identity\GoogleProfile;
use App\Services\UserSessions;
use App\Session\TieredSessionHandler;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\FakeIdentityProvider;
use Tests\TestCase;

/*
 * The session store of every environment (SESSION_DRIVER=redis-tiered): a signed-in session is
 * kept for the whole lifetime (14 days, rolling), a guest's (no account signed in: a visitor of
 * the public demo, a crawler, a sign-in on its way) for 2 hours at most, so anonymous traffic
 * cannot fill Redis (prod: 96 MB). The session cookie itself keeps the long lifetime.
 */
beforeEach(function () {
    expect((int) config('database.redis.default.database'))->toBe(15);
    Redis::connection()->flushdb();
    config(['session.driver' => 'redis-tiered', 'session.lifetime' => 20160]);
    app('session')->forgetDrivers();
    app()->forgetInstance('session.store');
    app()->instance(IdentityProvider::class, new FakeIdentityProvider);
});

/** Seconds the session store keeps this id (-2: gone). */
function storedFor(string $id): int
{
    $store = app('session')->driver()->getHandler()->getCache()->getStore();

    return (int) $store->connection()->ttl($store->getPrefix().$id);
}

function sessionIdOf(TestResponse $response): string
{
    $id = $response->getCookie(config('session.cookie'))?->getValue();
    expect($id)->toBeString()->not->toBe('');

    return $id;
}

/** A request as the SPA makes it, carrying the session cookie $id. */
function withSessionCookie(string $id): TestCase
{
    app('auth')->forgetGuards();

    return test()->withHeaders(['Referer' => 'http://localhost/'])->withCredentials()->withCookie(config('session.cookie'), $id);
}

test('the store is the tiered one', function () {
    expect(app('session')->driver()->getHandler())->toBeInstanceOf(TieredSessionHandler::class);
});

test('a guest\'s session (CSRF cookie, a call without an account) is kept 2 hours at most', function () {
    $response = test()->withHeaders(['Referer' => 'http://localhost/'])->get('/sanctum/csrf-cookie')->assertNoContent();
    $ttl = storedFor(sessionIdOf($response));
    expect($ttl)->toBeGreaterThan(7100)->toBeLessThanOrEqual(7200);

    $call = test()->withHeaders(['Referer' => 'http://localhost/'])->getJson('/api/v1/me')->assertUnauthorized();
    expect(storedFor(sessionIdOf($call)))->toBeLessThanOrEqual(7200);

    // A shorter configured lifetime wins.
    config(['session.lifetime' => 30]);
    app('session')->forgetDrivers();
    app()->forgetInstance('session.store');
    $short = test()->withHeaders(['Referer' => 'http://localhost/'])->get('/sanctum/csrf-cookie');
    expect(storedFor(sessionIdOf($short)))->toBeLessThanOrEqual(1800);
});

test('a signed-in session is kept the whole lifetime, renewed by every request; the cookie lasts as long', function () {
    $user = User::factory()->create();
    $store = app('session')->driver();
    $id = Str::random(40);
    $store->setId($id);
    $store->start();
    $store->put(Auth::guard('web')->getName(), $user->id);
    $store->save();
    expect(storedFor($id))->toBe(20160 * 60);

    $this->travel(1)->hour();
    $response = withSessionCookie($id)->getJson('/api/v1/me')->assertOk();
    expect(storedFor($id))->toBeGreaterThan(20160 * 60 - 5)
        ->and($response->getCookie(config('session.cookie'), false)->getExpiresTime())->toBe(now()->addMinutes(20160)->getTimestamp());
});

test('signing in with Google: the guest session is short, the signed-in one long, and the next request is signed in', function () {
    app(IdentityProvider::class)->returns(new GoogleProfile(sub: 'sub-1', email: 'alice@example.com', emailVerified: true, name: 'Alice', avatar: null));

    $start = test()->withHeaders(['Referer' => 'http://localhost/'])->postJson('/api/v1/auth/google/start', ['turnstile_token' => 'ok'])->assertOk();
    $guest = sessionIdOf($start);
    expect(storedFor($guest))->toBeLessThanOrEqual(7200);
    $state = session('google_oauth')['state'];

    // The callback signs in within the request: the session written at its end is the long one.
    $callback = withSessionCookie($guest)->get('/auth/google/callback?'.http_build_query(['code' => 'c', 'state' => $state]))->assertRedirect('/');
    $signedIn = sessionIdOf($callback);
    expect($signedIn)->not->toBe($guest)
        ->and(storedFor($signedIn))->toBe(20160 * 60)
        // The guest id is gone (rotated at sign-in).
        ->and(storedFor($guest))->toBe(-2);

    withSessionCookie($signedIn)->getJson('/api/v1/me')->assertOk()->assertJsonPath('name', 'Alice');

    // Signing out: the fresh session the browser is given is a guest's again.
    $logout = withSessionCookie($signedIn)->postJson('/api/v1/auth/logout')->assertNoContent();
    expect(storedFor(sessionIdOf($logout)))->toBeLessThanOrEqual(7200)
        ->and(app(UserSessions::class)->ended($signedIn))->toBeTrue();
    withSessionCookie($signedIn)->getJson('/api/v1/me')->assertUnauthorized();
});

test('everything Slax keeps in Redis but the queue carries an expiry, so volatile-lru can evict it when full', function () {
    // Production's stores, on the test database: cache and rate limits in Redis too.
    config(['cache.default' => 'redis', 'cache.stores.redis.connection' => 'default', 'cache.stores.redis.lock_connection' => 'default']);
    app('cache')->forgetDriver(['redis', 'array']);
    app()->forgetInstance('cache.store');
    app('session')->forgetDrivers();
    app()->forgetInstance('session.store');
    $this->seed(Database\Seeders\DefaultWorkspaceSeeder::class);
    app(IdentityProvider::class)->returns(new GoogleProfile(sub: 'sub-2', email: 'bob@example.com', emailVerified: true, name: 'Bob', avatar: null));

    $guest = sessionIdOf(test()->withHeaders(['Referer' => 'http://localhost/'])->postJson('/api/v1/auth/google/start', ['turnstile_token' => 'ok'])->assertOk());
    $id = sessionIdOf(withSessionCookie($guest)->get('/auth/google/callback?'.http_build_query(['code' => 'c', 'state' => session('google_oauth')['state']]))->assertRedirect('/'));
    $general = App\Models\Channel::where('name', 'general')->sole();
    withSessionCookie($id)->postJson('/api/v1/presence/heartbeat', ['active' => true])->assertNoContent();
    withSessionCookie($id)->getJson('/api/v1/presence?'.http_build_query(['user_ids' => [1]]))->assertOk();
    withSessionCookie($id)->postJson("/api/v1/channels/{$general->id}/join")->assertSuccessful();
    withSessionCookie($id)->postJson("/api/v1/channels/{$general->id}/messages", ['body' => 'hello', 'client_id' => (string) Str::uuid()])->assertCreated();
    withSessionCookie($id)->postJson('/api/v1/auth/logout')->assertNoContent();
    // The rate limiters (built at boot on the test's array store) and the audit's once-per keys, on Redis.
    $limiter = new Illuminate\Cache\RateLimiter(app('cache')->store('redis'));
    $limiter->hit('messages:user:1', 60);
    app('cache')->store('redis')->add('audit:once:x', 1, 600);
    app(UserSessions::class)->remember(User::sole(), 'another-session');

    $keys = Redis::connection()->keys('*');
    expect(count($keys))->toBeGreaterThan(5);
    $prefix = (string) config('database.redis.options.prefix');
    $forever = collect($keys)->filter(fn (string $key) => Redis::connection()->ttl(Str::after($key, $prefix)) < 0)->values()->all();
    expect($forever)->toBe([]);
});
