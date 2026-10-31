<?php

namespace App\Policies;

use App\Models\Channel;
use App\Models\User;
use Illuminate\Auth\Access\Response;

/**
 * Public channels are open to read and join; everything else needs membership.
 * A channel the user may not see answers 404, never 403, so its existence is not leaked.
 */
class ChannelPolicy
{
    /** Error code of a refusal because the channel is locked. */
    public const LOCKED = 'channel_locked';

    public function view(User $user, Channel $channel): Response
    {
        if ($channel->isPublic() || $channel->hasMember($user)) {
            return Response::allow();
        }

        return Response::denyAsNotFound();
    }

    /** Joining on your own is only for public channels; private ones are by invitation. */
    public function join(User $user, Channel $channel): bool
    {
        return $channel->isPublic();
    }

    public function leave(User $user, Channel $channel): bool
    {
        return $channel->isRoom();
    }

    /**
     * Members post, react and edit; in a locked channel only administrators do
     * (403 `channel_locked`, see bootstrap/app.php).
     */
    public function post(User $user, Channel $channel): Response
    {
        if (! $channel->hasMember($user)) {
            return Response::deny();
        }
        if ($channel->isLocked() && ! $user->is_admin) {
            return Response::deny('This channel is locked.', self::LOCKED);
        }

        return Response::allow();
    }

    /** Membership management: owners of public and private channels. */
    public function manage(User $user, Channel $channel): bool
    {
        return $channel->isRoom() && $channel->roleOf($user) === Channel::ROLE_OWNER;
    }
}
