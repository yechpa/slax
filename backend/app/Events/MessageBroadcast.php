<?php

namespace App\Events;

use App\Http\Resources\MessageResource;
use App\Models\Message;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * A change to a message, pushed to the members of its channel on `channel.{id}`.
 *
 * Dispatched only once the surrounding transaction commits (never for a rollback).
 * The payload is the REST resource of the message, rendered when the event is
 * created so that a queued broadcast cannot show a later state. It is the same for
 * every recipient, so `reacted_by_me` is false: clients derive it from `user_ids`.
 */
abstract class MessageBroadcast implements ShouldBroadcast, ShouldDispatchAfterCommit
{
    use Dispatchable;

    public int $channelId;

    public int $messageId;

    /** @var array<string, mixed> */
    public array $payload;

    public function __construct(Message $message)
    {
        $this->channelId = $message->channel_id;
        $this->messageId = $message->id;
        $this->payload = MessageResource::forBroadcast($message->refreshForDisplay());
    }

    abstract public function broadcastAs(): string;

    /** @return list<PrivateChannel> */
    public function broadcastOn(): array
    {
        return [new PrivateChannel("channel.{$this->channelId}")];
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return $this->payload;
    }
}
