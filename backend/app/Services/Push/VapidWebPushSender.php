<?php

namespace App\Services\Push;

use App\Models\PushSubscription;
use GuzzleHttp\Client;
use Minishlink\WebPush\Subscription;
use Minishlink\WebPush\WebPush;
use Psr\Http\Client\ClientInterface;
use Throwable;

/**
 * The real sender: minishlink/web-push (web-push-libs/web-push-php) encrypts the payload for the
 * browser (aes128gcm, RFC 8291) and signs the request with the VAPID key (RFC 8292). Short
 * timeouts: push jobs share the one queue worker with the broadcasts.
 */
class VapidWebPushSender implements WebPushSender
{
    private readonly ClientInterface $client;

    public function __construct(?ClientInterface $client = null)
    {
        $this->client = $client ?? new Client(['timeout' => 5, 'connect_timeout' => 3, 'allow_redirects' => false]);
    }

    public function send(PushSubscription $subscription, string $payload, array $options = []): PushResult
    {
        try {
            $webPush = new WebPush(
                ['VAPID' => [
                    'subject' => (string) config('slax.push.subject'),
                    'publicKey' => (string) config('slax.push.public_key'),
                    'privateKey' => (string) config('slax.push.private_key'),
                ]],
                ['TTL' => (int) config('slax.push.ttl_seconds')],
                $this->client,
            );
            $report = $webPush->sendOneNotification(
                Subscription::create([
                    'endpoint' => $subscription->endpoint,
                    'publicKey' => $subscription->p256dh,
                    'authToken' => $subscription->auth,
                    'contentEncoding' => 'aes128gcm',
                ]),
                $payload,
                array_intersect_key($options, array_flip(['topic', 'urgency'])),
            );
        } catch (Throwable $e) {
            // Unusable keys (ours or the browser's), a payload too large: trying again cannot help.
            return PushResult::rejected(null, $e::class.': '.$e->getMessage());
        }

        return PushResult::fromStatus($report->getResponse()?->getStatusCode(), $report->getReason());
    }
}
