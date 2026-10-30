<?php

namespace App\Jobs;

use App\Models\Message;
use App\Models\PushSubscription;
use App\Services\Push\Push;
use App\Services\Push\PushOutcome;
use App\Services\Push\WebPushSender;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * One notification to one device (PushNotifier queues them after the message committed).
 *
 * Checked again when it runs, since the queue may lag: the device still exists and was made
 * with the current VAPID key (otherwise deleted: the push service would refuse it), the person
 * is not banned and, for a message, the message still exists, is not deleted, and the person
 * is still a member of its channel.
 *
 * On the `push` queue: the worker drains `default` (broadcasts, revocations) first
 * (`queue:work --queue=default,push`), so a slow push service never delays realtime events.
 *
 * Gone (404/410): the device is deleted. No answer, 429 or 5xx: tried again after BACKOFF, then
 * dropped with a warning. Other refusals: dropped with a warning (the device is kept). Nothing
 * here throws on a push service's answer, so a failure never reaches the failed jobs table or
 * the administrators' alerts.
 */
class SendPushNotification implements ShouldQueue
{
    use Queueable;

    /** Seconds before the 2nd, 3rd and 4th tries. */
    public const BACKOFF = [30, 120, 600];

    public const QUEUE = 'push';

    public int $tries = 4;

    /**
     * @param  int|null  $channelId  the message's channel (null: the test button)
     * @param  int|null  $messageId  the message (null: the test button)
     * @param  array{type: string, title: string, body: string, url: string, tag: string}  $payload
     */
    public function __construct(public int $subscriptionId, public ?int $channelId, public ?int $messageId, public array $payload)
    {
        $this->onQueue(self::QUEUE);
    }

    public function handle(WebPushSender $sender): void
    {
        $device = PushSubscription::with('user')->find($this->subscriptionId);
        if ($device === null || ! Push::enabled()) {
            return;
        }
        if ($device->key_id !== Push::keyId()) {
            $device->delete();

            return;
        }
        if ($device->user->isBanned()) {
            return;
        }
        if ($this->messageId !== null && ! Message::whereKey($this->messageId)->whereNull('deleted_at')->exists()) {
            return;
        }
        if ($this->channelId !== null
            && ! DB::table('channel_members')->where('channel_id', $this->channelId)->where('user_id', $device->user_id)->exists()) {
            return;
        }

        $result = $sender->send($device, json_encode($this->payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), [
            'topic' => $this->payload['tag'],
        ]);

        // Never the endpoint (a capability URL) or the payload in the logs.
        $context = ['subscription' => $device->id, 'host' => parse_url($device->endpoint, PHP_URL_HOST), 'status' => $result->status];
        switch ($result->outcome) {
            case PushOutcome::Delivered:
                $device->forceFill(['last_used_at' => now()])->saveQuietly();
                break;
            case PushOutcome::Gone:
                $device->delete();
                break;
            case PushOutcome::Retry:
                if ($this->attempts() < $this->tries) {
                    $this->release(self::BACKOFF[min($this->attempts(), count(self::BACKOFF)) - 1]);
                } else {
                    Log::warning('Push notification dropped after retries', $context);
                }
                break;
            case PushOutcome::Rejected:
                Log::warning('Push notification refused by the push service', $context);
                break;
        }
    }
}
