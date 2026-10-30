<?php

use App\Contracts\AdminNotifier;
use App\Contracts\IdentityProvider;
use App\Models\AuditLog;
use App\Models\User;
use App\Services\Identity\GoogleProfile;
use App\Services\Turnstile;
use Illuminate\Support\Facades\Redis;
use Illuminate\Testing\TestResponse;
use Tests\Support\FakeIdentityProvider;
use Tests\Support\RecordingNotifier;

beforeEach(function () {
    expect((int) config('database.redis.default.database'))->toBe(15);
    Redis::connection()->flushdb();
    $this->notifier = new RecordingNotifier;
    app()->instance(AdminNotifier::class, $this->notifier);
    app()->instance(IdentityProvider::class, $this->identity = new FakeIdentityProvider);
});

/** The browser's return from Google, with a valid state unless told otherwise. */
function returnFromGoogle(string $ip = '10.0.0.1', bool $validState = true): TestResponse
{
    $oauth = ['state' => str_repeat('s', 40), 'nonce' => str_repeat('n', 40)];

    return test()->withServerVariables(['REMOTE_ADDR' => $ip])
        ->withSession(['google_oauth' => $oauth])
        ->get('/auth/google/callback?'.http_build_query(['code' => 'code', 'state' => $validState ? $oauth['state'] : 'forged']));
}

test('failed sign-ins are audited with their reason and address, never the e-mail', function () {
    returnFromGoogle(validState: false)->assertRedirect('/?auth_error=invalid_state');

    $this->identity->returns(new GoogleProfile(sub: 'sub-1', email: 'eve@example.com', emailVerified: false, name: 'Eve', avatar: null));
    returnFromGoogle()->assertRedirect('/?auth_error=email_unverified');

    $banned = User::factory()->banned()->create(['google_sub' => 'sub-2', 'name' => 'Old Name']);
    $this->identity->returns(new GoogleProfile(sub: 'sub-2', email: 'mallory@example.com', emailVerified: true, name: 'New Name', avatar: null));
    returnFromGoogle()->assertRedirect('/?auth_error=banned');
    // Refused before anything is written: the banned account's profile is left as it was.
    expect($banned->fresh()->name)->toBe('Old Name');

    app(Turnstile::class)->passes = false;
    test()->withHeaders(['Referer' => 'http://localhost/'])->postJson('/api/v1/auth/google/start', ['turnstile_token' => 'bad'])->assertUnprocessable();

    expect(AuditLog::orderBy('id')->pluck('action')->all())->toBe([
        'auth.sign_in_failed.invalid_state',
        'auth.sign_in_failed.email_unverified',
        'auth.sign_in_failed.banned',
        'auth.sign_in_failed.turnstile',
    ]);
    $entries = AuditLog::orderBy('id')->get();
    expect($entries[0]->ip)->toBe('10.0.0.1')
        ->and($entries[0]->actor_id)->toBeNull()
        ->and($entries[2]->target_type)->toBe('user')
        ->and($entries[2]->target_id)->toBe($banned->id)
        ->and($entries->toJson())->not->toContain('example.com');
});

test('a burst of failed sign-ins from one address alerts once per window', function () {
    config(['slax.alerts.failed_sign_in_threshold' => 3, 'slax.alerts.failed_sign_in_window_minutes' => 10]);
    $this->travelTo(now()->startOfHour());

    foreach (range(1, 5) as $_) {
        returnFromGoogle('10.0.0.7', validState: false);
    }
    // Another address has its own count.
    returnFromGoogle('10.0.0.8', validState: false);

    $bursts = $this->notifier->withTitle('Burst of failed sign-ins');
    expect($bursts)->toHaveCount(1)
        ->and($bursts[0]['context'])->toMatchArray(['failures' => 3, 'window_minutes' => 10])
        // The address stays in the audit log, not in the chat.
        ->and(json_encode($bursts))->not->toContain('10.0.0.7');

    $this->travel(11)->minutes();
    foreach (range(1, 3) as $_) {
        returnFromGoogle('10.0.0.7', validState: false);
    }
    expect($this->notifier->withTitle('Burst of failed sign-ins'))->toHaveCount(2);
});

test('a visitor signs up as a demo account, an administrator never does, and the session is indexed', function () {
    config(['slax.admin_emails' => ['boss@example.com']]);

    $this->identity->returns(new GoogleProfile(sub: 'sub-visitor', email: 'visitor@example.com', emailVerified: true, name: 'Visitor', avatar: null));
    returnFromGoogle()->assertRedirect('/');
    $visitor = User::where('google_sub', 'sub-visitor')->sole();
    expect($visitor->account_type)->toBe(User::ACCOUNT_DEMO)
        ->and($visitor->last_seen_at)->not->toBeNull()
        ->and(Redis::connection()->smembers("user-sessions:{$visitor->id}"))->toBe([session()->getId()]);

    test()->flushSession();
    app('auth')->forgetGuards();
    $this->identity->returns(new GoogleProfile(sub: 'sub-boss', email: 'boss@example.com', emailVerified: true, name: 'Boss', avatar: null));
    returnFromGoogle()->assertRedirect('/');
    expect(User::where('google_sub', 'sub-boss')->sole()->account_type)->toBe(User::ACCOUNT_MEMBER);

    // A demo account whose address becomes an administrator's stops being a demo account.
    config(['slax.admin_emails' => ['boss@example.com', 'visitor@example.com']]);
    test()->flushSession();
    app('auth')->forgetGuards();
    $this->identity->returns(new GoogleProfile(sub: 'sub-visitor', email: 'visitor@example.com', emailVerified: true, name: 'Visitor', avatar: null));
    returnFromGoogle()->assertRedirect('/');
    expect($visitor->fresh())->account_type->toBe(User::ACCOUNT_MEMBER)->is_admin->toBeTrue();
});

test('presence heartbeats record activity at most every 15 minutes', function () {
    $user = User::factory()->create(['last_seen_at' => now()->subHour()]);

    asUser($user)->postJson('/api/v1/presence/heartbeat', ['active' => true])->assertNoContent();
    $seen = $user->fresh()->last_seen_at;
    expect($seen->diffInSeconds(now()))->toBeLessThan(5);

    $this->travel(10)->minutes();
    asUser($user->fresh())->postJson('/api/v1/presence/heartbeat', ['active' => true])->assertNoContent();
    expect($user->fresh()->last_seen_at->equalTo($seen))->toBeTrue();

    $this->travel(6)->minutes();
    asUser($user->fresh())->postJson('/api/v1/presence/heartbeat', ['active' => false])->assertNoContent();
    expect($user->fresh()->last_seen_at->gt($seen))->toBeTrue();
});
