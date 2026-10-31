<?php

namespace App\Events;

use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * Someone else made a user a member of a channel (a new conversation, an owner's addition),
 * pushed to that user alone on `App.Models.User.{id}`, so their list shows it at once.
 *
 * Dispatched only once the surrounding transaction commits (never for a rollback). The
 * payload is the channel id alone: the client refetches its list over REST, which applies
 * the usual authorization, so nothing about the channel travels here.
 */
class ChannelAdded implements ShouldBroadcast, ShouldDispatchAfterCommit
{
    use Dispatchable;

    public function __construct(public int $channelId, public int $userId) {}

    public function broadcastAs(): string
    {
        return 'channel.added';
    }

    /** @return list<PrivateChannel> */
    public function broadcastOn(): array
    {
        return [new PrivateChannel("App.Models.User.{$this->userId}")];
    }

    /** @return array{channel_id: int} */
    public function broadcastWith(): array
    {
        return ['channel_id' => $this->channelId];
    }
}
