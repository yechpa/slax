<?php

namespace App\Listeners;

use App\Broadcasting\ReverbBroadcaster;
use App\Events\MemberRemoved;
use App\Events\UserBanned;
use App\Jobs\TerminateUserConnections;
use Illuminate\Contracts\Events\ShouldHandleEventsAfterCommit;
use Illuminate\Support\Facades\Broadcast;
use Throwable;

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
        $broadcaster = Broadcast::connection();

        if (! $broadcaster instanceof ReverbBroadcaster) {
            return;
        }

        try {
            // Short timeout: this runs inside the leave/remove request.
            $broadcaster->terminateUserConnections($event->user->id, timeoutSeconds: 2);
        } catch (Throwable $e) {
            // The membership change (or the ban) stands either way; keep trying in the background.
            report($e);
            TerminateUserConnections::dispatch($event->user->id);
        }
    }
}
