<?php

use App\Contracts\IdentityProvider;
use App\Events\UserRegistered;
use App\Models\User;
use App\Services\Identity\FakeIdentityProvider;
use App\Services\Identity\GoogleProfile;
use App\Services\Identity\IdentityProviderException;
use App\Services\Turnstile;
use Illuminate\Support\Facades\Event;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * The SPA calls the API from its own origin, which Sanctum treats as "stateful"
 * (session cookie). Requests without that origin get no session at all.
 */
function spa(): TestCase
{
    return test()->withHeaders(['Referer' => 'http://localhost/']);
}

function identity(): FakeIdentityProvider
{
    $provider = app(IdentityProvider::class);
    assert($provider instanceof FakeIdentityProvider);

    return $provider;
}

function googleProfile(array $overrides = []): GoogleProfile
{
    return new GoogleProfile(...array_merge([
        'sub' => 'google-sub-1',
        'email' => 'Alice@Example.com',
        'emailVerified' => true,
        'name' => 'Alice',
        'avatar' => 'https://lh3.example.test/alice.png',
    ], $overrides));
}

/** Runs `start` and returns what was stored in the session ({state, nonce}). */
function startLogin(): array
{
    spa()->postJson('/api/v1/auth/google/start', ['turnstile_token' => 'ok'])->assertOk();

    return session('google_oauth');
}

function callback(array $oauth, array $query = []): TestResponse
{
    return test()->withSession(['google_oauth' => $oauth])
        ->getJson('/auth/google/callback?'.http_build_query(array_merge(
            ['code' => 'auth-code', 'state' => $oauth['state']],
            $query,
        )));
}

test('start_rejects_bad_turnstile_token', function () {
    app(Turnstile::class)->passes = false;

    spa()->postJson('/api/v1/auth/google/start', ['turnstile_token' => 'bad'])
        ->assertUnprocessable()
        ->assertExactJson(['error' => 'turnstile_failed']);

    expect(session('google_oauth'))->toBeNull();

    spa()->postJson('/api/v1/auth/google/start', [])->assertUnprocessable()->assertJsonValidationErrors('turnstile_token');
});

test('start returns a google url carrying the state and nonce kept in session', function () {
    $response = spa()->postJson('/api/v1/auth/google/start', ['turnstile_token' => 'ok'])->assertOk();

    $oauth = session('google_oauth');
    parse_str(parse_url($response->json('redirect_url'), PHP_URL_QUERY), $query);

    expect($oauth['state'])->toHaveLength(40)
        ->and($oauth['nonce'])->toHaveLength(40)
        ->and($oauth['state'])->not->toBe($oauth['nonce'])
        ->and($query['state'])->toBe($oauth['state'])
        ->and($query['nonce'])->toBe($oauth['nonce']);
});

test('callback_rejects_wrong_state', function () {
    $oauth = startLogin();

    callback($oauth, ['state' => 'forged'])
        ->assertUnprocessable()
        ->assertExactJson(['error' => 'invalid_state']);

    test()->getJson('/auth/google/callback?code=x&state=anything')
        ->assertUnprocessable()
        ->assertExactJson(['error' => 'invalid_state']);

    expect(User::count())->toBe(0);
});

test('callback_rejects_wrong_nonce', function () {
    $oauth = startLogin();
    identity()->expectNonce('a-nonce-the-provider-did-not-sign');

    callback($oauth)->assertUnprocessable()->assertExactJson(['error' => 'invalid_token']);

    expect(User::count())->toBe(0);
});

test('callback hands the session nonce and the code to the identity provider', function () {
    $oauth = startLogin();
    identity()->returns(googleProfile())->expectNonce($oauth['nonce']);

    callback($oauth, ['code' => 'the-code'])->assertRedirect('/');

    expect(identity()->receivedNonce)->toBe($oauth['nonce'])
        ->and(identity()->receivedCode)->toBe('the-code');
});

test('callback fails closed when the provider throws', function () {
    $oauth = startLogin();
    identity()->throws(new IdentityProviderException('boom'));

    callback($oauth)->assertUnprocessable()->assertExactJson(['error' => 'invalid_token']);
    test()->assertGuest('web');
});

test('callback state and nonce are single use', function () {
    $oauth = startLogin();
    identity()->returns(googleProfile());

    callback($oauth)->assertRedirect('/');
    expect(session('google_oauth'))->toBeNull();

    test()->flushSession();
    test()->getJson('/auth/google/callback?'.http_build_query(['code' => 'c', 'state' => $oauth['state']]))
        ->assertUnprocessable();
});

test('unverified_google_email_refused', function () {
    $oauth = startLogin();
    identity()->returns(googleProfile(['emailVerified' => false]));

    callback($oauth)->assertForbidden()->assertExactJson(['error' => 'email_not_verified']);

    expect(User::count())->toBe(0);
    test()->assertGuest('web');
});

test('first_login_creates_user_and_second_reuses_by_google_sub', function () {
    Event::fake([UserRegistered::class]);
    identity()->returns(googleProfile());

    callback(startLogin())->assertRedirect('/');

    $user = User::sole();
    expect($user->google_sub)->toBe('google-sub-1')
        ->and($user->email)->toBe('alice@example.com')
        ->and($user->name)->toBe('Alice')
        ->and($user->avatar_url)->toBe('https://lh3.example.test/alice.png')
        ->and($user->locale)->toBe('en')
        ->and($user->theme)->toBe('console')
        ->and($user->is_admin)->toBeFalse()
        ->and($user->banned_at)->toBeNull();
    test()->assertAuthenticatedAs($user, 'web');
    Event::assertDispatchedTimes(UserRegistered::class, 1);
    Event::assertDispatched(UserRegistered::class, fn ($e) => $e->user->is($user));

    test()->flushSession();
    app('auth')->forgetGuards();
    identity()->returns(googleProfile(['name' => 'Alice B.']));

    callback(startLogin())->assertRedirect('/');

    expect(User::count())->toBe(1)
        ->and($user->fresh()->name)->toBe('Alice B.');
    Event::assertDispatchedTimes(UserRegistered::class, 1);
});

test('admin_flag_only_for_admin_emails', function () {
    config(['slax.admin_emails' => ['boss@example.com']]);

    identity()->returns(googleProfile(['sub' => 'sub-boss', 'email' => 'Boss@Example.com']));
    callback(startLogin())->assertRedirect('/');

    identity()->returns(googleProfile(['sub' => 'sub-other', 'email' => 'other@example.com']));
    callback(startLogin())->assertRedirect('/');

    expect(User::where('google_sub', 'sub-boss')->sole()->is_admin)->toBeTrue()
        ->and(User::where('google_sub', 'sub-other')->sole()->is_admin)->toBeFalse();
});

test('banned_user_cannot_login', function () {
    User::factory()->create(['google_sub' => 'google-sub-1', 'banned_at' => now()]);
    identity()->returns(googleProfile());

    callback(startLogin())->assertForbidden()->assertExactJson(['error' => 'account_banned']);

    test()->assertGuest('web');
});

test('banned user with a live session is cut off', function () {
    $user = User::factory()->create(['banned_at' => now()]);

    spa()->actingAs($user)->getJson('/api/v1/me')
        ->assertForbidden()
        ->assertExactJson(['error' => 'account_banned']);
});

test('start_is_rate_limited_10_per_minute_per_ip', function () {
    foreach (range(1, 10) as $_) {
        spa()->postJson('/api/v1/auth/google/start', ['turnstile_token' => 'ok'])->assertOk();
    }

    spa()->postJson('/api/v1/auth/google/start', ['turnstile_token' => 'ok'])->assertTooManyRequests();
    spa()->withServerVariables(['REMOTE_ADDR' => '10.9.9.9'])
        ->postJson('/api/v1/auth/google/start', ['turnstile_token' => 'ok'])->assertOk();
});

test('callback is rate limited per ip', function () {
    foreach (range(1, 20) as $_) {
        test()->getJson('/auth/google/callback?code=x&state=y')->assertUnprocessable();
    }

    test()->getJson('/auth/google/callback?code=x&state=y')->assertTooManyRequests();
});

test('me requires a session', function () {
    spa()->getJson('/api/v1/me')->assertUnauthorized();
});

test('me returns the current user without secrets', function () {
    $user = User::factory()->create(['name' => 'Alice', 'email' => 'alice@example.com']);

    spa()->actingAs($user)->getJson('/api/v1/me')
        ->assertOk()
        ->assertExactJson([
            'id' => $user->id,
            'name' => 'Alice',
            'email' => 'alice@example.com',
            'avatar_url' => $user->avatar_url,
            'locale' => 'en',
            'theme' => 'console',
            'is_admin' => false,
        ]);
});

test('patch me updates locale and theme', function () {
    $user = User::factory()->create();

    spa()->actingAs($user)->patchJson('/api/v1/me', ['locale' => 'he', 'theme' => 'listing'])
        ->assertOk()->assertJson(['locale' => 'he', 'theme' => 'listing']);

    expect($user->fresh())->locale->toBe('he')->theme->toBe('listing');
});

test('patch_me_rejects_unknown_locale', function () {
    $user = User::factory()->create();

    spa()->actingAs($user)->patchJson('/api/v1/me', ['locale' => 'de'])
        ->assertUnprocessable()->assertJsonValidationErrors('locale');
    spa()->actingAs($user)->patchJson('/api/v1/me', ['theme' => 'neon'])
        ->assertUnprocessable()->assertJsonValidationErrors('theme');
    spa()->actingAs($user)->patchJson('/api/v1/me', ['is_admin' => true, 'email' => 'x@y.z'])->assertOk();

    expect($user->fresh())->locale->toBe('en')->is_admin->toBeFalse();
});

test('logout ends the session', function () {
    $user = User::factory()->create();

    spa()->actingAs($user)->postJson('/api/v1/auth/logout')->assertNoContent();

    test()->assertGuest('web');
});
