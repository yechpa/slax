<?php

namespace App\Events;

/** A new message or thread reply. */
class MessageCreated extends MessageBroadcast
{
    public function broadcastAs(): string
    {
        return 'message.created';
    }
}
