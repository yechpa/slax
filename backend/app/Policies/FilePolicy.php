<?php

namespace App\Policies;

use App\Models\File;
use App\Models\User;
use Illuminate\Auth\Access\Response;
use Illuminate\Support\Facades\Gate;

/**
 * A file attached to a message is readable by whoever may view that message's channel;
 * an unattached one by its uploader only. Everything else answers 404, never 403, so
 * neither files nor private channels leak their existence.
 */
class FilePolicy
{
    public function download(User $user, File $file): Response
    {
        if (! $file->isAvailable()) {
            return Response::denyAsNotFound();
        }

        if ($file->message_id === null) {
            return $file->user_id === $user->id ? Response::allow() : Response::denyAsNotFound();
        }

        $message = $file->message;
        if ($message === null || $message->isDeleted()) {
            return Response::denyAsNotFound();
        }

        return Gate::forUser($user)->inspect('view', $message->channel);
    }
}
