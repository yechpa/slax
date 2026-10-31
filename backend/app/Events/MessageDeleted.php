<?php

namespace App\Events;

/** A message was deleted (the payload is its tombstone). */
class MessageDeleted extends MessageBroadcast
{
    public function broadcastAs(): string
    {
        return 'message.deleted';
    }
}
