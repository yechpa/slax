<?php

use App\Models\Channel;
use App\Models\File;
use App\Models\User;
use App\Services\FakeScannerClient;
use App\Services\ScannerClient;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use Illuminate\Broadcasting\BroadcastManager;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Minishlink\WebPush\VAPID;
use Tests\TestCase;

/*
|--------------------------------------------------------------------------
| Test Case
|--------------------------------------------------------------------------
|
| Feature tests boot the Laravel application on a real PostgreSQL database
| that is rolled back between tests; Unit tests stay framework-free.
|
*/

pest()->extend(TestCase::class)->use(RefreshDatabase::class)->in('Feature');

/*
|--------------------------------------------------------------------------
| Shared helpers (Feature tests seed the default workspace first)
|--------------------------------------------------------------------------
*/

/** Same-origin SPA call, authenticated by the session cookie. */
function asUser(User $user): TestCase
{
    return test()->withHeaders(['Referer' => 'http://localhost/'])->actingAs($user);
}

function privateChannel(User $owner, string $name = 'secret'): Channel
{
    $channel = Channel::factory()->private()->create(['name' => $name]);
    $channel->members()->attach($owner->id, ['role' => 'owner']);

    return $channel;
}

function publicChannel(User $owner, string $name = 'team'): Channel
{
    $channel = Channel::factory()->create(['name' => $name]);
    $channel->members()->attach($owner->id, ['role' => 'owner']);

    return $channel;
}

/** Channel callbacks live on the driver instance: register them again on the fresh Reverb one. */
function useReverbDriver(): void
{
    config(['broadcasting.default' => 'reverb']);
    app(BroadcastManager::class)->purge('reverb');
    require base_path('routes/channels.php');
}

/** POST /broadcasting/auth for any channel name, e.g. `private-channel.3` or `presence-workspace.1`. */
function authorizeChannelName(User $user, string $channelName, string $socketId = '1234.5678'): TestResponse
{
    return asUser($user)->postJson('/broadcasting/auth', [
        'socket_id' => $socketId,
        'channel_name' => $channelName,
    ]);
}

function authorizeChannel(User $user, int $channelId, string $socketId = '1234.5678'): TestResponse
{
    return authorizeChannelName($user, "private-channel.{$channelId}", $socketId);
}

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

/**
 * Redis down from now on: a new Redis manager pointed at a closed port (the manager keeps a
 * copy of its configuration, so changing the config alone is not enough). Resolve the services
 * under test after calling this.
 */
function breakRedis(): void
{
    config(['database.redis.default.port' => 1, 'database.redis.default.timeout' => 0.2, 'database.redis.default.read_timeout' => 0.2]);
    app()->forgetInstance('redis');
    app()->forgetInstance('redis.connection');
    Redis::clearResolvedInstance('redis');
}

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

/*
|--------------------------------------------------------------------------
| Files (the scanner is FakeScannerClient under APP_ENV=testing)
|--------------------------------------------------------------------------
*/

function scanner(): FakeScannerClient
{
    return app(ScannerClient::class);
}

/** A 1x1 PNG. */
function pngBytes(): string
{
    return base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==');
}

/** A real upload (in test mode) holding exactly these bytes, with the name and type the client declared. */
function uploadedFile(string $name, string $content, string $declaredMime = 'application/octet-stream'): UploadedFile
{
    $path = tempnam(sys_get_temp_dir(), 'upload-');
    file_put_contents($path, $content);

    return new UploadedFile($path, $name, $declaredMime, null, true);
}

function uploadTo(User $user, Channel $channel, UploadedFile $file): TestResponse
{
    return asUser($user)->postJson('/api/v1/files', ['file' => $file, 'channel_id' => $channel->id]);
}

/** A file row (no object behind it) uploaded by $user to $channel. */
function storedFile(User $user, Channel $channel, array $attributes = []): File
{
    return File::factory()->create(['user_id' => $user->id, 'channel_id' => $channel->id] + $attributes);
}

/*
|--------------------------------------------------------------------------
| Web Push (a fake sender under APP_ENV=testing: no test reaches a push service)
|--------------------------------------------------------------------------
*/

/** Push on, with a VAPID pair generated for this test run (never a real deployment's). */
function enablePush(): array
{
    $keys = VAPID::createVapidKeys();
    config([
        'slax.push.public_key' => $keys['publicKey'],
        'slax.push.private_key' => $keys['privateKey'],
        'slax.push.subject' => 'mailto:push-test@example.test',
    ]);

    return $keys;
}

function base64url(string $bytes): string
{
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

/** What a browser sends: a push service URL and its own keys (a P-256 point and 16 random bytes). */
function browserSubscription(string $endpoint = ''): array
{
    $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
    $ec = openssl_pkey_get_details($key)['ec'];

    return [
        'endpoint' => $endpoint ?: 'https://fcm.googleapis.com/fcm/send/'.Str::random(40),
        'keys' => [
            'p256dh' => base64url("\x04".str_pad($ec['x'], 32, "\0", STR_PAD_LEFT).str_pad($ec['y'], 32, "\0", STR_PAD_LEFT)),
            'auth' => base64url(random_bytes(16)),
        ],
    ];
}
