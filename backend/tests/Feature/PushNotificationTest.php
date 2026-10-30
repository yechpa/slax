<?php

use App\Jobs\SendPushNotification;
use App\Models\Channel;
use App\Models\Message;
use App\Models\PushSubscription;
use App\Models\User;
use App\Services\PresenceService;
use App\Services\Push\FakeWebPushSender;
use App\Services\Push\Push;
use App\Services\Push\PushResult;
use App\Services\Push\WebPushSender;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Exceptions;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
    // phpunit.xml points Redis at database 15 (presence lives there); never flush anything else.
    expect((int) config('database.redis.default.database'))->toBe(15);
    Redis::connection()->flushdb();
    enablePush();
});

/** A device of $user, written straight to the database (made with the current VAPID key). */
function device(User $user, string $locale = 'en'): PushSubscription
{
    return PushSubscription::create([
        'user_id' => $user->id,
        'endpoint' => 'https://fcm.googleapis.com/fcm/send/'.Str::random(40),
        'p256dh' => base64url("\x04".random_bytes(64)),
        'auth' => base64url(random_bytes(16)),
        'locale' => $locale,
        'key_id' => Push::keyId(),
    ]);
}

function postIn(User $user, Channel $channel, string $body = 'hello', ?int $parentId = null, array $extra = []): TestResponse
{
    return asUser($user)->postJson("/api/v1/channels/{$channel->id}/messages", [
        'body' => $body,
        'client_id' => (string) Str::uuid(),
        'parent_id' => $parentId,
    ] + $extra);
}

/** A conversation between these people (the first one opened it). */
function conversation(User ...$people): Channel
{
    $channel = Channel::factory()->dm(count($people) === 2 ? Channel::KIND_DM : Channel::KIND_GROUP_DM)->create(['created_by' => $people[0]->id]);
    foreach ($people as $person) {
        $channel->addMember($person);
    }

    return $channel;
}

function room(string $name, User ...$members): Channel
{
    $channel = Channel::factory()->create(['name' => $name]);
    foreach ($members as $member) {
        $channel->addMember($member);
    }

    return $channel;
}

function fakeSender(): FakeWebPushSender
{
    return app(WebPushSender::class);
}

/** @return list<int> subscription ids the queued jobs push to */
function pushedTo(): array
{
    return Queue::pushed(SendPushNotification::class)->map(fn (SendPushNotification $job) => $job->subscriptionId)->sort()->values()->all();
}

function onlyJobFor(PushSubscription $device): SendPushNotification
{
    $jobs = Queue::pushed(SendPushNotification::class, fn (SendPushNotification $job) => $job->subscriptionId === $device->id);
    expect($jobs)->toHaveCount(1);

    return $jobs->first();
}

test('a direct message: one job per device of the other person, none for the author', function () {
    Queue::fake();
    $alice = User::factory()->create(['name' => 'Alice Martin']);
    $bob = User::factory()->create();
    $dm = conversation($alice, $bob);
    $phone = device($bob);
    $laptop = device($bob);
    device($alice);

    postIn($alice, $dm, 'see you at 8')->assertCreated();

    expect(pushedTo())->toBe([$phone->id, $laptop->id]);
    $job = onlyJobFor($phone);
    expect($job->channelId)->toBe($dm->id)
        ->and($job->payload)->toBe([
            'type' => 'dm',
            'title' => 'Alice Martin (direct message)',
            'body' => 'New message',
            'url' => "/c/{$dm->id}",
            'tag' => "channel-{$dm->id}",
        ]);
});

test('a group conversation: every other member\'s devices', function () {
    Queue::fake();
    [$alice, $bob, $carol] = User::factory()->count(3)->create();
    $group = conversation($alice, $bob, $carol);
    $bobs = device($bob);
    $carols = device($carol);

    postIn($alice, $group)->assertCreated();

    expect(pushedTo())->toBe([$bobs->id, $carols->id]);
    expect(onlyJobFor($carols)->payload['type'])->toBe('dm');
});

test('a plain message in a room notifies nobody', function () {
    Queue::fake();
    [$alice, $bob] = User::factory()->count(2)->create();
    $room = room('family', $alice, $bob);
    device($bob);

    postIn($alice, $room, 'dinner is ready')->assertCreated();

    Queue::assertNotPushed(SendPushNotification::class);
});

test('a mention notifies the members it names, by first name or whole name', function () {
    Queue::fake();
    $alice = User::factory()->create(['name' => 'Alice Martin']);
    $bob = User::factory()->create(['name' => 'Bob Levi']);
    $dana = User::factory()->create(['name' => 'Dana Cohen']);
    $noa = User::factory()->create(['name' => 'Noa Peretz']);
    $room = room('family', $alice, $bob, $dana, $noa);
    $bobs = device($bob);
    $danas = device($dana);
    device($noa);

    postIn($alice, $room, 'hey @bob and @DanaCohen, mail me at noa@example.test')->assertCreated();

    expect(pushedTo())->toBe([$bobs->id, $danas->id]);
    expect(onlyJobFor($bobs)->payload)->toBe([
        'type' => 'mention',
        'title' => 'Alice Martin in #family',
        'body' => 'You were mentioned',
        'url' => "/c/{$room->id}",
        'tag' => "channel-{$room->id}",
    ]);
});

test('Hebrew names can be mentioned', function () {
    Queue::fake();
    $alice = User::factory()->create();
    $yael = User::factory()->create(['name' => 'יעל כהן']);
    $room = room('family', $alice, $yael);
    $yaels = device($yael);

    postIn($alice, $room, 'שלום @יעל!')->assertCreated();

    expect(pushedTo())->toBe([$yaels->id]);
});

test('a reply notifies whoever started or replied in the thread', function () {
    Queue::fake();
    $alice = User::factory()->create(['name' => 'Alice']);
    [$bob, $carol, $dana] = User::factory()->count(3)->create();
    $room = room('trips', $alice, $bob, $carol, $dana);
    $parent = Message::factory()->create(['channel_id' => $room->id, 'user_id' => $bob->id]);
    Message::factory()->create(['channel_id' => $room->id, 'user_id' => $carol->id, 'parent_id' => $parent->id]);
    $bobs = device($bob);
    $carols = device($carol);
    device($dana);
    device($alice);

    postIn($alice, $room, 'count me in', $parent->id)->assertCreated();

    expect(pushedTo())->toBe([$bobs->id, $carols->id]);
    expect(onlyJobFor($carols)->payload)->toBe([
        'type' => 'reply',
        'title' => 'Alice in #trips',
        'body' => 'New reply',
        'url' => "/c/{$room->id}/t/{$parent->id}",
        'tag' => "channel-{$room->id}",
    ]);
});

test('one notification per device even when several reasons apply (mention wins)', function () {
    Queue::fake();
    $alice = User::factory()->create();
    $bob = User::factory()->create(['name' => 'Bob']);
    $dm = conversation($alice, $bob);
    $parent = Message::factory()->create(['channel_id' => $dm->id, 'user_id' => $bob->id]);
    $bobs = device($bob);

    postIn($alice, $dm, '@bob look', $parent->id)->assertCreated();

    expect(onlyJobFor($bobs)->payload['type'])->toBe('mention');
});

test('the author is never notified, even mentioning themselves or replying to their own thread', function () {
    Queue::fake();
    $alice = User::factory()->create(['name' => 'Alice']);
    $bob = User::factory()->create();
    $room = room('notes', $alice, $bob);
    $parent = Message::factory()->create(['channel_id' => $room->id, 'user_id' => $alice->id]);
    device($alice);

    postIn($alice, $room, 'note to @alice', $parent->id)->assertCreated();

    Queue::assertNotPushed(SendPushNotification::class);
});

test('banned members and non-members get nothing', function () {
    Queue::fake();
    $alice = User::factory()->create();
    $bob = User::factory()->create(['name' => 'Bob']);
    $carol = User::factory()->create(['name' => 'Carol']);
    $room = room('family', $alice, $bob);
    device($bob);
    device($carol);
    $bob->forceFill(['banned_at' => now()])->save();

    // Carol is mentioned but not a member of the room.
    postIn($alice, $room, '@bob @carol')->assertCreated();

    Queue::assertNotPushed(SendPushNotification::class);
});

test('someone using Slax right now (a presence heartbeat in the last 60 s) gets no push', function () {
    Queue::fake();
    [$alice, $bob] = User::factory()->count(2)->create();
    $dm = conversation($alice, $bob);
    $bobs = device($bob);

    // A tab that pings, active or in the background, counts as connected.
    app(PresenceService::class)->heartbeat($bob->id, false);
    postIn($alice, $dm)->assertCreated();
    Queue::assertNotPushed(SendPushNotification::class);

    $this->travel(61)->seconds();
    postIn($alice, $dm)->assertCreated();
    expect(pushedTo())->toBe([$bobs->id]);
});

test('the payload never carries the text, an address or a file name: exactly type, title, body, url, tag', function () {
    Queue::fake();
    $alice = User::factory()->create(['name' => 'Alice', 'email' => 'alice.private@example.test']);
    $bob = User::factory()->create(['email' => 'bob.private@example.test']);
    $dm = conversation($alice, $bob);
    $bobs = device($bob);
    $file = storedFile($alice, $dm, ['display_name' => 'medical-results.pdf', 'scan_status' => 'clean']);

    postIn($alice, $dm, 'the secret code is 4242', null, ['file_ids' => [$file->id]])->assertCreated();

    $payload = onlyJobFor($bobs)->payload;
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    expect(array_keys($payload))->toBe(['type', 'title', 'body', 'url', 'tag'])
        ->and($json)->not->toContain('4242')
        ->and($json)->not->toContain('secret')
        ->and($json)->not->toContain('medical')
        ->and($json)->not->toContain('@example.test');
});

test('notifications are written in each device\'s language', function () {
    Queue::fake();
    $alice = User::factory()->create(['name' => 'Alice']);
    $bob = User::factory()->create(['name' => 'Bob', 'locale' => 'en']);
    $room = room('family', $alice, $bob);
    $hebrew = device($bob, 'he');
    $french = device($bob, 'fr');
    $english = device($bob, 'en');

    postIn($alice, $room, '@bob')->assertCreated();

    expect(onlyJobFor($french)->payload)->toMatchArray(['title' => 'Alice dans #family', 'body' => 'Nouvelle mention'])
        ->and(onlyJobFor($english)->payload)->toMatchArray(['title' => 'Alice in #family', 'body' => 'You were mentioned']);
    // Names are isolated (FSI … PDI) inside the Hebrew sentence.
    expect(onlyJobFor($hebrew)->payload)->toMatchArray([
        'title' => "\u{2068}Alice\u{2069} בערוץ \u{2068}#family\u{2069}",
        'body' => 'הוזכרת בהודעה',
    ]);
});

test('push off: nothing is queued', function () {
    Queue::fake();
    [$alice, $bob] = User::factory()->count(2)->create();
    $dm = conversation($alice, $bob);
    device($bob);
    config(['slax.push.public_key' => '']);

    postIn($alice, $dm)->assertCreated();

    Queue::assertNotPushed(SendPushNotification::class);
});

test('a push service failure never fails sending the message', function () {
    // The queue runs jobs inline in tests (sync): the sender's exception surfaces in the request.
    Exceptions::fake();
    fakeSender()->throws = new RuntimeException('push service down');
    [$alice, $bob] = User::factory()->count(2)->create();
    $dm = conversation($alice, $bob);
    device($bob);

    postIn($alice, $dm, 'still delivered')->assertCreated();

    expect(Message::where('body', 'still delivered')->exists())->toBeTrue();
    // Reported (an error for the administrators), not thrown at the author.
    Exceptions::assertReported(RuntimeException::class);
});

test('the job sends the payload to the device and records the delivery', function () {
    [$alice, $bob] = User::factory()->count(2)->create();
    $dm = conversation($alice, $bob);
    $bobs = device($bob);

    postIn($alice, $dm)->assertCreated();

    expect(fakeSender()->sent)->toHaveCount(1);
    [$subscription, $json, $options] = fakeSender()->sent[0];
    expect($subscription->id)->toBe($bobs->id)
        ->and(array_keys(json_decode($json, true)))->toBe(['type', 'title', 'body', 'url', 'tag'])
        ->and($options)->toBe(['topic' => "channel-{$dm->id}"])
        ->and($bobs->fresh()->last_used_at)->not->toBeNull();
});

test('a device the push service says is gone (404, 410) is deleted', function (int $status) {
    [$alice, $bob] = User::factory()->count(2)->create();
    $dm = conversation($alice, $bob);
    $gone = device($bob);
    $kept = device($bob);
    fakeSender()->results[$gone->endpoint] = PushResult::gone($status);

    postIn($alice, $dm)->assertCreated();

    expect(PushSubscription::whereKey($gone->id)->exists())->toBeFalse()
        ->and(PushSubscription::whereKey($kept->id)->exists())->toBeTrue();
})->with([404, 410]);

test('a temporary failure is retried with a backoff, then dropped', function () {
    [$alice, $bob] = User::factory()->count(2)->create();
    $dm = conversation($alice, $bob);
    $bobs = device($bob);
    fakeSender()->results[$bobs->endpoint] = PushResult::retry(503, 'unavailable');
    $job = new SendPushNotification($bobs->id, $dm->id, ['type' => 'dm', 'title' => 't', 'body' => 'b', 'url' => '/', 'tag' => 'x']);

    $job->withFakeQueueInteractions();
    $job->handle(fakeSender());
    $job->assertReleased(SendPushNotification::BACKOFF[0]);

    Log::spy();
    $last = (new SendPushNotification($bobs->id, $dm->id, $job->payload))->withFakeQueueInteractions();
    $last->job->attempts = $last->tries;
    $last->handle(fakeSender());
    $last->assertNotReleased()->assertNotFailed();
    Log::shouldHaveReceived('warning')->once();
    // Dropped, not deleted: the device may work again tomorrow.
    expect(PushSubscription::whereKey($bobs->id)->exists())->toBeTrue();
});

test('a refusal (400, 403, 413) is not retried and keeps the device', function () {
    [$alice, $bob] = User::factory()->count(2)->create();
    $dm = conversation($alice, $bob);
    $bobs = device($bob);
    fakeSender()->results[$bobs->endpoint] = PushResult::rejected(403, 'forbidden');

    $job = (new SendPushNotification($bobs->id, $dm->id, ['type' => 'dm', 'title' => 't', 'body' => 'b', 'url' => '/', 'tag' => 'x']))->withFakeQueueInteractions();
    $job->handle(fakeSender());

    $job->assertNotReleased()->assertNotFailed();
    expect(PushSubscription::whereKey($bobs->id)->exists())->toBeTrue();
});

test('after a key rotation, devices subscribed with the old key are deleted, not pushed', function () {
    [$alice, $bob] = User::factory()->count(2)->create();
    $dm = conversation($alice, $bob);
    $old = device($bob);
    enablePush(); // a new pair

    postIn($alice, $dm)->assertCreated();

    expect(fakeSender()->sent)->toBe([])
        ->and(PushSubscription::whereKey($old->id)->exists())->toBeFalse();
});

test('the job checks again when it runs: banned or removed since, nothing is sent', function () {
    [$alice, $bob] = User::factory()->count(2)->create();
    $room = room('family', $alice, $bob);
    $bobs = device($bob);
    $payload = ['type' => 'mention', 'title' => 't', 'body' => 'b', 'url' => '/', 'tag' => 'x'];

    DB::table('channel_members')->where('channel_id', $room->id)->where('user_id', $bob->id)->delete();
    (new SendPushNotification($bobs->id, $room->id, $payload))->handle(fakeSender());
    expect(fakeSender()->sent)->toBe([]);

    $room->addMember($bob);
    $bob->forceFill(['banned_at' => now()])->save();
    (new SendPushNotification($bobs->id, $room->id, $payload))->handle(fakeSender());
    expect(fakeSender()->sent)->toBe([]);

    // A device removed meanwhile: nothing to do.
    $bobs->delete();
    (new SendPushNotification($bobs->id, $room->id, $payload))->handle(fakeSender());
    expect(fakeSender()->sent)->toBe([]);
});
