<?php

namespace App\Jobs;

use App\Broadcasting\ReverbBroadcaster;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Broadcast;

/** Retry path for TerminateRevokedConnections when Reverb could not be reached right away. */
class TerminateUserConnections implements ShouldQueue
{
    use Queueable;

    public int $tries = 6;

    /** @var list<int> */
    public array $backoff = [1, 5, 15, 30, 60];

    public function __construct(public int $userId) {}

    public function handle(): void
    {
        $broadcaster = Broadcast::connection();

        if ($broadcaster instanceof ReverbBroadcaster) {
            $broadcaster->terminateUserConnections($this->userId);
        }
    }
}
