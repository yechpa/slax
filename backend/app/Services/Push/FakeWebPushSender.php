<?php

namespace App\Services\Push;

use App\Models\PushSubscription;
use Throwable;

/**
 * Bound only when APP_ENV is `testing` or `e2e`: records what would have been sent and answers
 * "delivered", unless a test sets an answer per endpoint or an exception to throw.
 */
class FakeWebPushSender implements WebPushSender
{
    /** @var list<array{PushSubscription, string, array<string, string>}> */
    public array $sent = [];

    /** @var array<string, PushResult> by endpoint */
    public array $results = [];

    public ?Throwable $throws = null;

    public function send(PushSubscription $subscription, string $payload, array $options = []): PushResult
    {
        if ($this->throws !== null) {
            throw $this->throws;
        }
        $this->sent[] = [$subscription, $payload, $options];

        return $this->results[$subscription->endpoint] ?? PushResult::delivered();
    }
}
