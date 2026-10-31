<?php

use App\Models\PushSubscription;
use App\Models\User;
use App\Services\Push\Push;
use App\Services\Push\PushOutcome;
use App\Services\Push\VapidWebPushSender;
use Database\Seeders\DefaultWorkspaceSeeder;
use GuzzleHttp\Client;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;

/*
| The real sender, against a mocked HTTP client: no test ever reaches a push service.
*/

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
    enablePush();
});

/** @return array{VapidWebPushSender, ArrayObject} */
function senderAnswering(Response|Throwable ...$answers): array
{
    $history = new ArrayObject;
    $stack = HandlerStack::create(new MockHandler($answers));
    $stack->push(Middleware::history($history));

    return [new VapidWebPushSender(new Client(['handler' => $stack])), $history];
}

function realDevice(): PushSubscription
{
    $browser = browserSubscription();

    return PushSubscription::create([
        'user_id' => User::factory()->create()->id,
        'endpoint' => $browser['endpoint'],
        'p256dh' => $browser['keys']['p256dh'],
        'auth' => $browser['keys']['auth'],
        'locale' => 'en',
        'key_id' => Push::keyId(),
    ]);
}

test('an encrypted, VAPID-signed POST to the endpoint', function () {
    [$sender, $history] = senderAnswering(new Response(201));
    $device = realDevice();
    $payload = json_encode(['type' => 'dm', 'title' => 'Alice (direct message)', 'body' => 'New message', 'url' => '/c/1', 'tag' => 'channel-1']);

    $result = $sender->send($device, $payload, ['topic' => 'channel-1']);

    expect($result->outcome)->toBe(PushOutcome::Delivered);
    /** @var Request $request */
    $request = $history[0]['request'];
    expect($request->getMethod())->toBe('POST')
        ->and((string) $request->getUri())->toBe($device->endpoint)
        ->and($request->getHeaderLine('Content-Encoding'))->toBe('aes128gcm')
        ->and($request->getHeaderLine('TTL'))->toBe((string) config('slax.push.ttl_seconds'))
        ->and($request->getHeaderLine('Topic'))->toBe('channel-1')
        ->and($request->getHeaderLine('Authorization'))->toStartWith('vapid t=')
        ->and($request->getHeaderLine('Authorization'))->toContain('k='.config('slax.push.public_key'));
    // Encrypted: the plain text is nowhere in the body.
    $body = (string) $request->getBody();
    expect($body)->not->toContain('Alice')->and($body)->not->toContain('direct message');
});

test('answers map to delivered, gone, retry or rejected', function (Response|Throwable $answer, PushOutcome $outcome) {
    [$sender] = senderAnswering($answer);

    expect($sender->send(realDevice(), '{}', [])->outcome)->toBe($outcome);
})->with([
    '201' => [fn () => new Response(201), PushOutcome::Delivered],
    '404' => [fn () => new Response(404), PushOutcome::Gone],
    '410' => [fn () => new Response(410), PushOutcome::Gone],
    '429' => [fn () => new Response(429), PushOutcome::Retry],
    '500' => [fn () => new Response(500), PushOutcome::Retry],
    '503' => [fn () => new Response(503), PushOutcome::Retry],
    'no answer' => [fn () => new ConnectException('timeout', new Request('POST', 'https://fcm.googleapis.com/x')), PushOutcome::Retry],
    '400' => [fn () => new Response(400), PushOutcome::Rejected],
    '403' => [fn () => new Response(403), PushOutcome::Rejected],
    '413' => [fn () => new Response(413), PushOutcome::Rejected],
]);

test('a device whose keys cannot be used is rejected, not thrown', function () {
    [$sender, $history] = senderAnswering(new Response(201));
    $device = realDevice();
    $device->p256dh = base64url("\x04".str_repeat("\x01", 64)); // not a point on the curve

    expect($sender->send($device, '{}', [])->outcome)->toBe(PushOutcome::Rejected)
        ->and($history)->toHaveCount(0);
});
