<?php

namespace App\Policies;

use App\Models\Message;
use App\Models\User;

/**
 * Seeing a message is ChannelPolicy::view on its channel. Changing it is for its
 * author only (administrator moderation comes separately).
 */
class MessagePolicy
{
    public function update(User $user, Message $message): bool
    {
        return $message->user_id === $user->id;
    }

    public function delete(User $user, Message $message): bool
    {
        return $message->user_id === $user->id;
    }
}
