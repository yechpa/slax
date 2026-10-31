<?php

namespace App\Services\Push;

use App\Models\PushSubscription;

/**
 * Sends one encrypted Web Push message to one browser. VapidWebPushSender does it for real;
 * tests and the e2e stack get FakeWebPushSender (AppServiceProvider), so no automated run ever
 * reaches a push service.
 */
interface WebPushSender
{
    /**
     * @param  string  $payload  JSON, encrypted for the browser before it leaves the server
     * @param  array{topic?: string, urgency?: string}  $options
     */
    public function send(PushSubscription $subscription, string $payload, array $options = []): PushResult;
}
