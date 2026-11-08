<?php

namespace App\Policies;

use App\Models\Task;
use App\Models\User;
use Illuminate\Auth\Access\Response;

/**
 * A task the user may not see answers 404, never 403, so its existence is not leaked
 * (ChannelPolicy style); a visible one they may not change answers 403.
 */
class TaskPolicy
{
    public function view(User $user, Task $task): Response
    {
        return $task->isVisibleTo($user) ? Response::allow() : Response::denyAsNotFound();
    }

    /** Title, visibility and assignee: the creator's. */
    public function edit(User $user, Task $task): Response
    {
        return $task->creator_id === $user->id
            ? Response::allow()
            : $this->denyUnlessHidden($user, $task);
    }

    /** Ticking and unticking: the creator's or the assignee's. */
    public function complete(User $user, Task $task): Response
    {
        return $task->creator_id === $user->id || $task->assignee_id === $user->id
            ? Response::allow()
            : $this->denyUnlessHidden($user, $task);
    }

    public function delete(User $user, Task $task): Response
    {
        return $this->edit($user, $task);
    }

    private function denyUnlessHidden(User $user, Task $task): Response
    {
        return $task->isVisibleTo($user) ? Response::deny() : Response::denyAsNotFound();
    }
}
