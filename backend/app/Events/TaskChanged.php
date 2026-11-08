<?php

namespace App\Events;

use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * A task changed (created, edited, completed, moved, handed on, returned or deleted) for someone who
 * created or holds it, pushed to that user alone on `App.Models.User.{id}` so their task pages refetch.
 *
 * Dispatched only once the surrounding transaction commits (never for a rollback). The payload is the
 * task id alone, never the title or visibility: the client refetches over REST, which applies the
 * usual authorization.
 */
class TaskChanged implements ShouldBroadcast, ShouldDispatchAfterCommit
{
    use Dispatchable;

    public function __construct(public int $taskId, public int $userId) {}

    public function broadcastAs(): string
    {
        return 'task.changed';
    }

    /** @return list<PrivateChannel> */
    public function broadcastOn(): array
    {
        return [new PrivateChannel("App.Models.User.{$this->userId}")];
    }

    /** @return array{task_id: int} */
    public function broadcastWith(): array
    {
        return ['task_id' => $this->taskId];
    }
}
