<?php

use App\Events\MemberRemoved;
use App\Events\ReactionChanged;
use App\Http\Resources\MessageResource;
use App\Jobs\TerminateUserConnections;
use App\Models\File;
use App\Models\Message;
use App\Models\User;
use App\Services\FileNames;
use Database\Seeders\DefaultWorkspaceSeeder;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Message as GuzzleMessage;
use GuzzleHttp\Psr7\Response;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\RequestException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Exceptions;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use Psr\Http\Message\RequestInterface;
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
    fakeTerminations();
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

/** Fakes Reverb's HTTP API for the termination calls (made with the Http client). */
function fakeTerminations(mixed $response = null): void
{
    Http::fake(['reverb.test:8080/apps/*' => $response ?? Http::response('{}')]);
}

/** @return list<string> paths of the termination calls the app made */
function terminationPaths(): array
{
    return Http::recorded()->map(fn ($pair) => $pair[0]->toPsrRequest()->getUri()->getPath())->values()->all();
}

test('removing a member terminates their live Reverb connections', function () {
    fakeReverb();
    fakeTerminations();
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($member->id);

    asUser($owner)->deleteJson("/api/v1/channels/{$channel->id}/members/{$member->id}")->assertNoContent();

    Http::assertSentCount(1);
    $request = Http::recorded()->first()[0]->toPsrRequest();
    expect($request->getMethod())->toBe('POST')
        ->and($request->getUri()->getHost())->toBe('reverb.test')
        ->and($request->getUri()->getPath())->toBe("/apps/test-app/users/{$member->id}/terminate_connections")
        ->and((string) $request->getBody())->toBe('{}');
    assertSignedForReverb($request);
});

test('leaving a channel terminates the leaver connections too', function () {
    fakeReverb();
    fakeTerminations();
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($member->id);

    asUser($member)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNoContent();
    // Not a member any more: nothing to revoke.
    asUser($member)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNoContent();

    expect(terminationPaths())->toBe(["/apps/test-app/users/{$member->id}/terminate_connections"]);
});

test('connections are terminated only once the removal is committed', function () {
    fakeReverb();
    fakeTerminations();
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($member->id);

    // Terminating earlier would let the client reconnect and be re-authorized before the commit.
    DB::transaction(function () use ($channel, $member) {
        $channel->members()->detach($member->id);
        MemberRemoved::dispatch($channel, $member);

        Http::assertNothingSent();
    });
    Http::assertSentCount(1);

    DB::beginTransaction();
    MemberRemoved::dispatch($channel, $member);
    DB::rollBack();
    Http::assertSentCount(1);
});

test('a failed termination is reported and retried from the queue', function () {
    fakeReverb();
    fakeTerminations(Http::response('down', 500));
    Exceptions::fake();
    Queue::fake();
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($member->id);

    // The removal itself stands: the channel authorization already refuses the user.
    asUser($owner)->deleteJson("/api/v1/channels/{$channel->id}/members/{$member->id}")->assertNoContent();
    authorizeChannel($member, $channel->id)->assertForbidden();

    Exceptions::assertReported(fn (RequestException $e) => $e->response->status() === 500);
    Queue::assertPushed(TerminateUserConnections::class, fn ($job) => $job->userId === $member->id);
});

test('the termination call gives up after 2 seconds instead of blocking the request', function () {
    // A server that accepts the connection and never answers.
    $server = stream_socket_server('tcp://127.0.0.1:0');
    $port = (int) Str::afterLast(stream_socket_get_name($server, false), ':');
    fakeReverb();
    config(['broadcasting.connections.reverb.options' => ['host' => '127.0.0.1', 'port' => $port, 'scheme' => 'http', 'useTLS' => false]]);
    useReverbDriver();
    Exceptions::fake();
    Queue::fake();
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($member->id);

    $started = microtime(true);
    asUser($member)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNoContent();
    $elapsed = microtime(true) - $started;

    expect($elapsed)->toBeGreaterThan(1.5)->toBeLessThan(5);
    Exceptions::assertReported(ConnectionException::class);
    Queue::assertPushed(TerminateUserConnections::class);
    fclose($server);
});

test('the retry job calls Reverb and fails loudly so the queue retries', function () {
    fakeReverb();
    fakeTerminations(Http::sequence()->push('{}')->push('busy', 503));

    (new TerminateUserConnections(42))->handle();
    expect(terminationPaths())->toBe(['/apps/test-app/users/42/terminate_connections']);

    expect(fn () => (new TerminateUserConnections(42))->handle())->toThrow(RequestException::class);
    expect((new TerminateUserConnections(42))->tries)->toBeGreaterThan(1);
});

/** Size of the whole HTTP request the Pusher SDK sent for the last broadcast (what Reverb buffers). */
function lastBroadcastRequestSize(ArrayObject $history, string $event): int
{
    $requests = array_values(array_filter(
        $history->getArrayCopy(),
        fn ($entry) => str_ends_with($entry['request']->getUri()->getPath(), '/events')
            && json_decode((string) $entry['request']->getBody(), true)['name'] === $event,
    ));
    expect($requests)->not->toBeEmpty();

    return strlen(GuzzleMessage::toString(end($requests)['request']));
}

test('the largest message broadcasts fit in a Reverb request', function (string $character) {
    $history = fakeReverb(...array_fill(0, 10, new Response(200, [], '{}')));
    $limit = (int) config('reverb.servers.reverb.max_request_size');
    $author = User::factory()->create();
    $channel = publicChannel($author);
    // Worst case for message.updated: 20 emoji with the most reactors listed, ids of 7 digits.
    $reactors = User::factory()->count(MessageResource::MAX_REACTION_USER_IDS)
        ->sequence(fn ($sequence) => ['id' => 9_000_000 + $sequence->index])->create();

    // The Pusher SDK JSON-encodes the payload twice: א becomes \\u05d0 (7 bytes for a
    // 2-byte Hebrew letter), an astral emoji 14 bytes, so 4000 characters reach ~56 KB.
    $body = str_repeat($character, Message::MAX_BODY);
    // Plus the most files a message carries, with the longest names.
    $files = File::factory()->count(Message::MAX_FILES)->create([
        'user_id' => $author->id,
        'channel_id' => $channel->id,
        'display_name' => str_repeat($character, FileNames::MAX_LENGTH - 4).'.txt',
        'size' => File::MAX_BYTES,
    ]);
    $id = asUser($author)->postJson("/api/v1/channels/{$channel->id}/messages", [
        'body' => $body, 'client_id' => (string) Str::uuid(), 'file_ids' => $files->modelKeys(),
    ])->assertCreated()->assertJsonCount(Message::MAX_FILES, 'files')->json('id');
    $created = lastBroadcastRequestSize($history, 'message.created');

    $emoji = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙', '😚', '🙂', '🤗'];
    DB::table('reactions')->insert(collect($emoji)->crossJoin($reactors->pluck('id'))
        ->map(fn ($pair) => ['message_id' => $id, 'emoji' => $pair[0], 'user_id' => $pair[1]])->all());
    asUser($author)->patchJson("/api/v1/messages/{$id}", ['body' => mb_substr($body, 1).'!'])->assertOk();
    $updated = lastBroadcastRequestSize($history, 'message.updated');

    expect($created)->toBeGreaterThan(Message::MAX_BODY * 6)
        ->and($created)->toBeLessThan($limit)
        ->and($updated)->toBeLessThan($limit);
})->with([
    'hebrew' => ['א'],
    'astral emoji' => ['😀'],
    'control character' => ["\u{0001}"],
]);

test('reaction payloads list at most 50 reactors but keep the true count', function () {
    Event::fake([ReactionChanged::class]);
    $author = User::factory()->create();
    $channel = publicChannel($author);
    $message = Message::factory()->create(['channel_id' => $channel->id, 'user_id' => $author->id]);
    $reactors = User::factory()->count(60)->create();
    DB::table('reactions')->insert($reactors->map(fn ($u) => ['message_id' => $message->id, 'user_id' => $u->id, 'emoji' => '👍'])->all());

    $rest = asUser($reactors->last())->getJson("/api/v1/channels/{$channel->id}/messages")->json('data.0.reactions.0');
    expect($rest['count'])->toBe(60)
        ->and($rest['user_ids'])->toBe($reactors->take(50)->pluck('id')->all())
        // reacted_by_me is computed from all reactors, not just the listed ones.
        ->and($rest['reacted_by_me'])->toBeTrue();

    asUser($author)->putJson("/api/v1/messages/{$message->id}/reactions/".rawurlencode('👍'))->assertOk()
        ->assertJsonPath('reactions.0.count', 61)->assertJsonCount(50, 'reactions.0.user_ids');
    $payload = Event::dispatched(ReactionChanged::class)->sole()[0]->broadcastWith();
    expect($payload['reactions'][0]['count'])->toBe(61)->and($payload['reactions'][0]['user_ids'])->toHaveCount(50);
});

test('nothing is sent when broadcasting is not on Reverb', function () {
    Http::fake();
    Queue::fake();
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($member->id);

    asUser($member)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNoContent();

    Http::assertNothingSent();
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

    // The longest Hebrew body (~29 KB on the wire once double-encoded) still gets through.
    $long = str_repeat('שלום ', 799).'סוף!!';
    expect(mb_strlen($long))->toBe(4000);
    $send($long);
    expect(json_decode($memberSocket->waitFor('message.created')['data'], true)['body'])->toBe($long);
    expect(json_decode($ownerSocket->waitFor('message.created')['data'], true)['body'])->toBe($long);

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
