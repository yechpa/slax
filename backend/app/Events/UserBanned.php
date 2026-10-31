<?php

namespace App\Events;

use App\Models\User;
use Illuminate\Foundation\Events\Dispatchable;

/** Fired once an administrator's ban is committed: the user's open sockets must close. */
class UserBanned
{
    use Dispatchable;

    public function __construct(public User $user) {}
}
