<?php

namespace App\Events;

/** A message's body was edited. */
class MessageUpdated extends MessageBroadcast
{
    public function broadcastAs(): string
    {
        return 'message.updated';
    }
}
