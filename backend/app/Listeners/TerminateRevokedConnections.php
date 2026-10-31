<?php

namespace App\Listeners;

use App\Events\MemberRemoved;
use App\Events\UserBanned;
use App\Jobs\TerminateUserConnections;
use Illuminate\Contracts\Events\ShouldHandleEventsAfterCommit;

/**
 * A user who leaves or is removed from a channel, or is banned, must stop receiving its
 * events, even on a socket that is already subscribed. The Pusher protocol cannot drop a
 * single subscription from the server side, so the user's sockets are closed:
 * clients reconnect and re-authorize every channel, and `channel.{id}` now refuses.
 *
 * Runs after commit: terminating earlier would let the client re-authorize before
 * the membership is gone.
 */
class TerminateRevokedConnections implements ShouldHandleEventsAfterCommit
{
    public function handle(MemberRemoved|UserBanned $event): void
    {
        // The membership change (or the ban) stands either way; a failure is retried from the queue.
        TerminateUserConnections::now($event->user->id);
    }
}
