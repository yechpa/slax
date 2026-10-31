<?php

namespace App\Events;

/** A reaction was added to or removed from a message (the payload carries the new aggregate). */
class ReactionChanged extends MessageBroadcast
{
    public function broadcastAs(): string
    {
        return 'reaction.changed';
    }
}
