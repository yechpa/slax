<?php

use App\Events\MemberRemoved;
use App\Jobs\TerminateUserConnections;
use App\Models\User;
use Database\Seeders\DefaultWorkspaceSeeder;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use Illuminate\Broadcasting\BroadcastManager;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Exceptions;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Psr\Http\Message\RequestInterface;
use Pusher\ApiErrorException;
use Tests\Support\WebSocketClient;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

const REVERB_SECRET = 'test-secret';

/**
 * Broadcasts through the Reverb driver, whose HTTP API calls hit a Guzzle mock.
 * Returns the history of the requests the app sent to Reverb.
 */
function fakeReverb(Response ...$responses): ArrayObject
{
    $history = new ArrayObject;
    $stack = HandlerStack::create(new MockHandler($responses ?: array_fill(0, 5, new Response(200, [], '{}'))));
    $stack->push(Middleware::history($history));

    config([
        'broadcasting.connections.reverb' => [
            'driver' => 'reverb',
            'key' => 'test-key',
            'secret' => REVERB_SECRET,
            'app_id' => 'test-app',
            'options' => ['host' => 'reverb.test', 'port' => 8080, 'scheme' => 'http', 'useTLS' => false],
            'client_options' => ['handler' => $stack],
        ],
    ]);
    useReverbDriver();

    return $history;
}

/** Channel callbacks live on the driver instance: register them again on the fresh Reverb one. */
function useReverbDriver(): void
{
    config(['broadcasting.default' => 'reverb']);
    app(BroadcastManager::class)->purge('reverb');
    require base_path('routes/channels.php');
}

function authorizeChannel(User $user, int $channelId, string $socketId = '1234.5678'): TestResponse
{
    return asUser($user)->postJson('/broadcasting/auth', [
        'socket_id' => $socketId,
        'channel_name' => "private-channel.{$channelId}",
    ]);
}

/** Checks a Pusher HTTP API signature the way Reverb does. */
function assertSignedForReverb(RequestInterface $request): void
{
    parse_str($request->getUri()->getQuery(), $query);
    $signature = $query['auth_signature'];
    unset($query['auth_signature']);
    ksort($query);
    $toSign = $request->getMethod()."\n".$request->getUri()->getPath()."\n".urldecode(http_build_query($query));

    expect($query['auth_key'])->toBe('test-key')
        ->and(hash_equals(hash_hmac('sha256', $toSign, REVERB_SECRET), $signature))->toBeTrue();
}

test('a member is authorized on the channel and tagged with their user id', function () {
    fakeReverb();
    $user = User::factory()->create();
    $channel = publicChannel($user);

    $auth = authorizeChannel($user, $channel->id)->assertOk()->json();

    // The subscription carries the user id (signed), so Reverb can later terminate the user's sockets.
    expect($auth['channel_data'])->toBe(json_encode(['user_id' => (string) $user->id]));
    $expected = hash_hmac('sha256', "1234.5678:private-channel.{$channel->id}:{$auth['channel_data']}", REVERB_SECRET);
    expect($auth['auth'])->toBe("test-key:{$expected}");
});

test('channel authorization is refused to non-members, guests, banned users and unknown channels', function () {
    fakeReverb();
    $owner = User::factory()->create();
    $outsider = User::factory()->create();
    $public = publicChannel($owner);
    $private = privateChannel($owner);

    // Guests first (acting as a user sticks for the rest of the test).
    test()->withHeaders(['Referer' => 'http://localhost/'])
        ->postJson('/broadcasting/auth', ['socket_id' => '1.2', 'channel_name' => "private-channel.{$public->id}"])
        ->assertForbidden();

    // Public channels can be read over REST, but live events are for members.
    authorizeChannel($outsider, $public->id)->assertForbidden();
    authorizeChannel($outsider, $private->id)->assertForbidden();
    authorizeChannel($owner, 999999)->assertForbidden();

    $owner->forceFill(['banned_at' => now()])->save();
    authorizeChannel($owner, $public->id)->assertForbidden()->assertExactJson(['error' => 'account_banned']);
});

test('removed_member_loses_channel_authorization', function () {
    fakeReverb();
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $leaver = User::factory()->create();
    $channel = privateChannel($owner);
    $channel->members()->attach([$member->id, $leaver->id]);

    authorizeChannel($member, $channel->id)->assertOk();
    authorizeChannel($leaver, $channel->id)->assertOk();

    asUser($owner)->deleteJson("/api/v1/channels/{$channel->id}/members/{$member->id}")->assertNoContent();
    asUser($leaver)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNoContent();

    authorizeChannel($member, $channel->id)->assertForbidden();
    authorizeChannel($leaver, $channel->id)->assertForbidden();
    authorizeChannel($owner, $channel->id)->assertOk();
});

test('removing a member terminates their live Reverb connections', function () {
    $history = fakeReverb();
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($member->id);

    asUser($owner)->deleteJson("/api/v1/channels/{$channel->id}/members/{$member->id}")->assertNoContent();

    expect($history)->toHaveCount(1);
    $request = $history[0]['request'];
    expect($request->getMethod())->toBe('POST')
        ->and($request->getUri()->getHost())->toBe('reverb.test')
        ->and($request->getUri()->getPath())->toBe("/apps/test-app/users/{$member->id}/terminate_connections");
    assertSignedForReverb($request);
});

test('leaving a channel terminates the leaver connections too', function () {
    $history = fakeReverb();
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($member->id);

    asUser($member)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNoContent();
    // Not a member any more: nothing to revoke.
    asUser($member)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNoContent();

    expect($history)->toHaveCount(1)
        ->and($history[0]['request']->getUri()->getPath())->toBe("/apps/test-app/users/{$member->id}/terminate_connections");
});

test('connections are terminated only once the removal is committed', function () {
    $history = fakeReverb();
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($member->id);

    // Terminating earlier would let the client reconnect and be re-authorized before the commit.
    DB::transaction(function () use ($channel, $member, $history) {
        $channel->members()->detach($member->id);
        MemberRemoved::dispatch($channel, $member);

        expect($history)->toHaveCount(0);
    });
    expect($history)->toHaveCount(1);

    DB::beginTransaction();
    MemberRemoved::dispatch($channel, $member);
    DB::rollBack();
    expect($history)->toHaveCount(1);
});

test('a failed termination is reported and retried from the queue', function () {
    fakeReverb(new Response(500, [], 'down'));
    Exceptions::fake();
    Queue::fake();
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($member->id);

    // The removal itself stands: the channel authorization already refuses the user.
    asUser($owner)->deleteJson("/api/v1/channels/{$channel->id}/members/{$member->id}")->assertNoContent();
    authorizeChannel($member, $channel->id)->assertForbidden();

    Exceptions::assertReported(fn (ApiErrorException $e) => $e->getMessage() === 'down');
    Queue::assertPushed(TerminateUserConnections::class, fn ($job) => $job->userId === $member->id);
});

test('the retry job calls Reverb and fails loudly so the queue retries', function () {
    $history = fakeReverb(new Response(200, [], '{}'), new Response(503, [], 'busy'));

    (new TerminateUserConnections(42))->handle();
    expect($history)->toHaveCount(1)
        ->and($history[0]['request']->getUri()->getPath())->toBe('/apps/test-app/users/42/terminate_connections');

    expect(fn () => (new TerminateUserConnections(42))->handle())->toThrow(Exception::class);
    expect((new TerminateUserConnections(42))->tries)->toBeGreaterThan(1);
});

test('nothing is sent when broadcasting is not on Reverb', function () {
    Queue::fake();
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($member->id);

    asUser($member)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNoContent();

    Queue::assertNothingPushed();
});

/*
 * End-to-end against the Reverb server of the dev stack (real WebSocket).
 * Excluded from the default run (phpunit.xml); `make test-reverb` starts Reverb and runs it.
 */
test('reverb_e2e_removed_member_socket_is_cut_and_cannot_resubscribe', function () {
    useReverbDriver();
    $host = config('broadcasting.connections.reverb.options.host');
    $port = (int) config('broadcasting.connections.reverb.options.port');
    $key = config('broadcasting.connections.reverb.key');

    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = privateChannel($owner);
    $channel->members()->attach($member->id);
    $name = "private-channel.{$channel->id}";

    $subscribe = function (User $user) use ($host, $port, $key, $channel, $name): WebSocketClient {
        $socket = WebSocketClient::connect($host, $port, "/app/{$key}?protocol=7&client=slax-e2e&version=1.0");
        $socketId = json_decode($socket->waitFor('pusher:connection_established')['data'], true)['socket_id'];
        $auth = authorizeChannel($user, $channel->id, $socketId)->assertOk()->json();
        $socket->send(['event' => 'pusher:subscribe', 'data' => ['channel' => $name] + $auth]);
        expect($socket->waitFor('pusher_internal:subscription_succeeded'))->not->toBeNull();

        return $socket;
    };

    $memberSocket = $subscribe($member);
    $ownerSocket = $subscribe($owner);

    $send = fn (string $body) => asUser($owner)->postJson("/api/v1/channels/{$channel->id}/messages", [
        'body' => $body, 'client_id' => (string) Str::uuid(),
    ])->assertCreated();

    $send('before removal');
    expect(json_decode($memberSocket->waitFor('message.created')['data'], true)['body'])->toBe('before removal');
    expect(json_decode($ownerSocket->waitFor('message.created')['data'], true)['body'])->toBe('before removal');

    asUser($owner)->deleteJson("/api/v1/channels/{$channel->id}/members/{$member->id}")->assertNoContent();

    // Reverb closed the member's socket...
    expect($memberSocket->waitFor('message.created', 3))->toBeNull()
        ->and($memberSocket->isClosed())->toBeTrue();

    // ...while the owner's socket still gets the channel's events.
    $send('after removal');
    expect(json_decode($ownerSocket->waitFor('message.created')['data'], true)['body'])->toBe('after removal');

    // Reconnecting gets a new socket, but the channel is refused.
    $again = WebSocketClient::connect($host, $port, "/app/{$key}?protocol=7&client=slax-e2e&version=1.0");
    $socketId = json_decode($again->waitFor('pusher:connection_established')['data'], true)['socket_id'];
    authorizeChannel($member, $channel->id, $socketId)->assertForbidden();

    $again->close();
    $ownerSocket->close();
})->group('reverb-e2e')->skip(! getenv('REVERB_E2E'), 'Opt-in: set REVERB_E2E=1 with the dev Reverb server running.');
