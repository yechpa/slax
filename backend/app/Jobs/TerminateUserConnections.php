<?php

namespace App\Jobs;

use App\Broadcasting\ReverbBroadcaster;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Broadcast;
use Throwable;

/** Closing a user's Reverb sockets: right away (now()), or from the queue when that failed. */
class TerminateUserConnections implements ShouldQueue
{
    use Queueable;

    public int $tries = 6;

    /** @var list<int> */
    public array $backoff = [1, 5, 15, 30, 60];

    public function __construct(public int $userId) {}

    /**
     * Closes the user's sockets now (2 s at most: this runs inside requests and commands),
     * or keeps trying from the queue when Reverb cannot be reached. A no-op unless
     * broadcasting goes through Reverb.
     */
    public static function now(int $userId): void
    {
        $broadcaster = Broadcast::connection();

        if (! $broadcaster instanceof ReverbBroadcaster) {
            return;
        }

        try {
            $broadcaster->terminateUserConnections($userId, timeoutSeconds: 2);
        } catch (Throwable $e) {
            report($e);
            self::dispatch($userId);
        }
    }

    public function handle(): void
    {
        $broadcaster = Broadcast::connection();

        if ($broadcaster instanceof ReverbBroadcaster) {
            $broadcaster->terminateUserConnections($this->userId, timeoutSeconds: 10);
        }
    }
}
