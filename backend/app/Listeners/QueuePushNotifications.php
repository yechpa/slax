<?php

namespace App\Listeners;

use App\Events\MessageCreated;
use App\Models\Message;
use App\Services\Push\PushNotifier;
use Illuminate\Contracts\Events\ShouldHandleEventsAfterCommit;
use Throwable;

/**
 * Web Push for a new message, once it is committed. Whatever goes wrong here (Redis, the
 * queue, a sync job's push service in tests) is reported and swallowed: the message is sent
 * and its author gets their 201.
 */
class QueuePushNotifications implements ShouldHandleEventsAfterCommit
{
    public function __construct(private readonly PushNotifier $notifier) {}

    public function handle(MessageCreated $event): void
    {
        try {
            $message = Message::with(['channel', 'user'])->find($event->messageId);
            if ($message !== null) {
                $this->notifier->messageCreated($message);
            }
        } catch (Throwable $e) {
            report($e);
        }
    }
}
