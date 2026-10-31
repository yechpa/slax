<?php

namespace App\Events;

use App\Models\User;
use Illuminate\Foundation\Events\Dispatchable;

/** Fired once, when a user signs in for the first time. */
class UserRegistered
{
    use Dispatchable;

    public function __construct(public User $user) {}
}
