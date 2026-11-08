<?php

namespace App\Policies;

use App\Models\TaskList;
use App\Models\User;
use Illuminate\Auth\Access\Response;

/** Lists are personal: anyone but the owner gets a 404, as if the list did not exist. */
class TaskListPolicy
{
    public function manage(User $user, TaskList $list): Response
    {
        return $list->user_id === $user->id ? Response::allow() : Response::denyAsNotFound();
    }
}
