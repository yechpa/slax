<?php

namespace App\Events;

use App\Models\Channel;
use App\Models\User;
use Illuminate\Foundation\Events\Dispatchable;

/** Fired after a user stops being a member of a channel (left, or removed by an owner). */
class MemberRemoved
{
    use Dispatchable;

    public function __construct(public Channel $channel, public User $user) {}
}
