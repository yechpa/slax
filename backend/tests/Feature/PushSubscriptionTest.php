<?php

use App\Jobs\SendPushNotification;
use App\Models\PushSubscription;
use App\Models\User;
use App\Services\Moderation;
use App\Services\Push\Push;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Queue;
use Minishlink\WebPush\VAPID;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

function subscribeDevice(User $user, array $subscription, array $extra = [])
{
    return asUser($user)->postJson('/api/v1/push/subscriptions', $subscription + $extra);
}

test('push is off without VAPID keys: every push endpoint but unsubscribing answers 404', function () {
    config(['slax.push.public_key' => '', 'slax.push.private_key' => '']);
    $user = User::factory()->create();

    expect(Push::enabled())->toBeFalse();
    asUser($user)->getJson('/api/v1/push/public-key')->assertNotFound()->assertExactJson(['error' => 'push_disabled']);
    subscribeDevice($user, browserSubscription())->assertNotFound();
    asUser($user)->postJson('/api/v1/push/test')->assertNotFound();
    // Cleaning up a device stays possible (keys removed after people subscribed).
    asUser($user)->deleteJson('/api/v1/push/subscriptions', ['endpoint' => 'https://fcm.googleapis.com/fcm/send/x'])->assertNotFound();
    expect(PushSubscription::count())->toBe(0);
});

test('one key without the other, or no subject, is off too', function () {
    $keys = enablePush();
    config(['slax.push.private_key' => '']);
    expect(Push::enabled())->toBeFalse();

    enablePush();
    config(['slax.push.subject' => '']);
    expect(Push::enabled())->toBeFalse();

    config(['slax.push.subject' => 'https://slax.example.test']);
    expect(Push::enabled())->toBeTrue();
});

test('the public key is given to signed-in people', function () {
    $keys = enablePush();
    $user = User::factory()->create();

    asUser($user)->getJson('/api/v1/push/public-key')->assertOk()->assertExactJson(['public_key' => $keys['publicKey']]);
});

test('every push endpoint needs a session, and refuses banned accounts', function () {
    enablePush();
    $this->getJson('/api/v1/push/public-key')->assertUnauthorized();
    $this->postJson('/api/v1/push/subscriptions', browserSubscription())->assertUnauthorized();
    $this->deleteJson('/api/v1/push/subscriptions', ['endpoint' => 'https://fcm.googleapis.com/fcm/send/x'])->assertUnauthorized();
    $this->postJson('/api/v1/push/test')->assertUnauthorized();

    $banned = User::factory()->banned()->create();
    subscribeDevice($banned, browserSubscription())->assertForbidden();
    expect(PushSubscription::count())->toBe(0);
});

test('subscribing stores the device; the same endpoint again updates it (upsert)', function () {
    enablePush();
    $user = User::factory()->create(['locale' => 'fr']);
    $device = browserSubscription();

    subscribeDevice($user, $device, ['locale' => 'he'])->assertNoContent();
    $row = PushSubscription::sole();
    expect($row->user_id)->toBe($user->id)
        ->and($row->endpoint)->toBe($device['endpoint'])
        ->and($row->p256dh)->toBe($device['keys']['p256dh'])
        ->and($row->auth)->toBe($device['keys']['auth'])
        ->and($row->locale)->toBe('he')
        ->and($row->key_id)->toBe(Push::keyId());

    // The browser renewed its keys; no language given: the account's.
    $renewed = browserSubscription($device['endpoint']);
    subscribeDevice($user, $renewed)->assertNoContent();
    $row = PushSubscription::sole();
    expect($row->p256dh)->toBe($renewed['keys']['p256dh'])
        ->and($row->auth)->toBe($renewed['keys']['auth'])
        ->and($row->locale)->toBe('fr');
});

test('only push services are accepted as endpoints (the queue worker POSTs to them)', function (string $endpoint) {
    enablePush();
    $user = User::factory()->create();

    subscribeDevice($user, browserSubscription($endpoint))->assertUnprocessable()->assertJsonValidationErrors('endpoint');
    expect(PushSubscription::count())->toBe(0);
})->with([
    'plain http' => 'http://fcm.googleapis.com/fcm/send/abc',
    'metadata service' => 'https://169.254.169.254/latest/meta-data',
    'an in-cluster service' => 'https://slax-postgres:5432/',
    'any other host' => 'https://evil.test/push',
    'a lookalike host' => 'https://fcm.googleapis.com.evil.test/fcm/send/abc',
    'a lookalike suffix' => 'https://evilpush.apple.com/x',
    'user info' => 'https://fcm.googleapis.com@evil.test/abc',
    'another port' => 'https://fcm.googleapis.com:8443/fcm/send/abc',
    'not a URL' => 'fcm.googleapis.com/fcm/send/abc',
]);

test('the push services of Chrome, Firefox, Safari and Edge are accepted', function (string $endpoint) {
    enablePush();
    subscribeDevice(User::factory()->create(), browserSubscription($endpoint))->assertNoContent();
})->with([
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGuQyavXutnMH',
    'https://wns2-db5p.notify.windows.com/w/?token=BQYAAAB',
]);

test('malformed browser keys are refused', function (array $keys) {
    enablePush();
    $device = browserSubscription();
    $device['keys'] = $keys + $device['keys'];

    subscribeDevice(User::factory()->create(), $device)->assertUnprocessable();
    expect(PushSubscription::count())->toBe(0);
})->with([
    'p256dh not base64url' => [['p256dh' => 'not/base64+url==']],
    'p256dh too short' => [['p256dh' => base64url(random_bytes(32))]],
    'p256dh not an uncompressed point' => [['p256dh' => base64url("\x02".random_bytes(64))]],
    'auth too short' => [['auth' => base64url(random_bytes(8))]],
    'auth missing' => [['auth' => '']],
]);

test('ten devices per account: the eleventh replaces the one unused for longest', function () {
    enablePush();
    $user = User::factory()->create();
    $endpoints = [];
    foreach (range(1, 10) as $i) {
        $endpoints[$i] = "https://fcm.googleapis.com/fcm/send/device-{$i}";
        subscribeDevice($user, browserSubscription($endpoints[$i]))->assertNoContent();
        $this->travel(1)->minutes();
    }
    // Device 1 was pushed to recently; device 2 never was and is the oldest after it.
    PushSubscription::where('endpoint', $endpoints[1])->update(['last_used_at' => now()]);

    subscribeDevice($user, browserSubscription('https://fcm.googleapis.com/fcm/send/device-11'))->assertNoContent();

    $left = PushSubscription::where('user_id', $user->id)->pluck('endpoint');
    expect($left)->toHaveCount(PushSubscription::MAX_PER_USER)
        ->and($left)->toContain($endpoints[1], 'https://fcm.googleapis.com/fcm/send/device-11')
        ->and($left)->not->toContain($endpoints[2]);
    // Re-subscribing a known device never evicts another.
    subscribeDevice($user, browserSubscription($endpoints[3]))->assertNoContent();
    expect(PushSubscription::where('user_id', $user->id)->count())->toBe(PushSubscription::MAX_PER_USER);
});

test('a device signed in to another account moves to the one that subscribes it', function () {
    enablePush();
    [$first, $second] = User::factory()->count(2)->create();
    $device = browserSubscription();

    subscribeDevice($first, $device)->assertNoContent();
    subscribeDevice($second, browserSubscription($device['endpoint']))->assertNoContent();

    expect(PushSubscription::sole()->user_id)->toBe($second->id);
});

test('unsubscribing removes the caller\'s own device only', function () {
    enablePush();
    [$owner, $other] = User::factory()->count(2)->create();
    $device = browserSubscription();
    subscribeDevice($owner, $device)->assertNoContent();

    asUser($other)->deleteJson('/api/v1/push/subscriptions', ['endpoint' => $device['endpoint']])->assertNotFound();
    expect(PushSubscription::count())->toBe(1);

    asUser($owner)->deleteJson('/api/v1/push/subscriptions', ['endpoint' => $device['endpoint']])->assertNoContent();
    expect(PushSubscription::count())->toBe(0);

    asUser($owner)->deleteJson('/api/v1/push/subscriptions', [])->assertUnprocessable();
});

test('the test button pushes to the caller\'s own devices only, and is throttled', function () {
    enablePush();
    Queue::fake();
    [$user, $other] = User::factory()->count(2)->create();
    subscribeDevice($user, browserSubscription(), ['locale' => 'fr'])->assertNoContent();
    subscribeDevice($user, browserSubscription(), ['locale' => 'en'])->assertNoContent();
    subscribeDevice($other, browserSubscription())->assertNoContent();

    asUser($user)->postJson('/api/v1/push/test')->assertAccepted()->assertExactJson(['devices' => 2]);

    $mine = PushSubscription::where('user_id', $user->id)->pluck('id')->all();
    Queue::assertPushed(SendPushNotification::class, 2);
    Queue::assertPushedOn('push', SendPushNotification::class);
    Queue::assertPushed(SendPushNotification::class, fn (SendPushNotification $job) => in_array($job->subscriptionId, $mine, true)
        && $job->channelId === null
        && $job->messageId === null
        && array_keys($job->payload) === ['type', 'title', 'body', 'url', 'tag']
        && $job->payload['type'] === 'test'
        && $job->payload['url'] === '/');
    $french = PushSubscription::where('user_id', $user->id)->where('locale', 'fr')->sole();
    Queue::assertPushed(SendPushNotification::class, fn (SendPushNotification $job) => $job->subscriptionId === $french->id
        && $job->payload['body'] === 'Les notifications fonctionnent sur cet appareil.');

    asUser($user)->postJson('/api/v1/push/test')->assertAccepted();
    asUser($user)->postJson('/api/v1/push/test')->assertAccepted();
    asUser($user)->postJson('/api/v1/push/test')->assertTooManyRequests();
});

test('a ban removes every device of the account', function () {
    enablePush();
    $user = User::factory()->create();
    subscribeDevice($user, browserSubscription())->assertNoContent();
    subscribeDevice($user, browserSubscription())->assertNoContent();

    app(Moderation::class)->ban($user);

    expect(PushSubscription::count())->toBe(0);
});

test('a deleted account takes its devices with it', function () {
    enablePush();
    $user = User::factory()->create();
    subscribeDevice($user, browserSubscription())->assertNoContent();

    $user->delete();

    expect(PushSubscription::count())->toBe(0);
});

test('slax:push-keys prints a fresh VAPID pair and writes nothing', function () {
    $before = file_get_contents(base_path('.env'));

    $this->artisan('slax:push-keys')
        ->expectsOutputToContain('VAPID_PUBLIC_KEY=')
        ->expectsOutputToContain('VAPID_PRIVATE_KEY=')
        ->assertSuccessful();

    expect(file_get_contents(base_path('.env')))->toBe($before);

    // The printed values: base64url, a P-256 point (65 bytes) and a scalar (32 bytes), new each run.
    $pairs = [];
    foreach (range(1, 2) as $ignored) {
        Artisan::call('slax:push-keys');
        $output = Artisan::output(); // read once: fetching empties the buffer
        preg_match('/^VAPID_PUBLIC_KEY=([A-Za-z0-9_-]+)$/m', $output, $public);
        preg_match('/^VAPID_PRIVATE_KEY=([A-Za-z0-9_-]+)$/m', $output, $private);
        expect(strlen(base64_decode(strtr($public[1], '-_', '+/'))))->toBe(65)
            ->and(strlen(base64_decode(strtr($private[1], '-_', '+/'))))->toBe(32);
        $pairs[] = $public[1];
        // A pair the library accepts.
        VAPID::validate(['subject' => 'mailto:a@example.test', 'publicKey' => $public[1], 'privateKey' => $private[1]]);
    }
    expect($pairs[0])->not->toBe($pairs[1]);
});

test('notification texts exist in English, Hebrew and French alike', function () {
    $keys = fn (string $locale) => array_keys(require lang_path("{$locale}/push.php"));

    expect($keys('he'))->toBe($keys('en'))
        ->and($keys('fr'))->toBe($keys('en'));
});
