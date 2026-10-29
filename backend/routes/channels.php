<?php

use App\Models\Channel;
use App\Models\User;
use Illuminate\Support\Facades\Broadcast;

/*
 * Private channels, authorized by POST /broadcasting/auth. The check runs live
 * on every subscription, so a user who left or was removed is refused at once
 * (their open sockets are closed by TerminateRevokedConnections).
 */

// Message events of a channel or DM: members only, even for public channels
// (non-members read public channels over REST).
Broadcast::channel('channel.{channel}', fn (User $user, Channel $channel) => $channel->hasMember($user));

Broadcast::channel('App.Models.User.{id}', fn (User $user, $id) => (int) $user->id === (int) $id);
