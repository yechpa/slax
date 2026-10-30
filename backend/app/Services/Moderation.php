<?php

namespace App\Services;

use App\Events\MessageDeleted;
use App\Events\MessageUpdated;
use App\Events\UserBanned;
use App\Models\Channel;
use App\Models\File;
use App\Models\Message;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * What administrators do to other people's accounts and content. Authorization is the
 * caller's job (the `admin` gate on every admin route); each change is audited, and the
 * audit sends the administrators an alert (AuditLogger). Every operation is idempotent:
 * repeating it changes nothing and records nothing more.
 */
class Moderation
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly UserSessions $sessions,
        private readonly PresenceService $presence,
        private readonly StoredFiles $files,
    ) {}

    /**
     * Banned: refused everywhere (EnsureNotBanned, sign-in), every session destroyed,
     * shown offline, sockets closed (after commit, retried from the queue if Reverb cannot
     * be reached; see TerminateRevokedConnections). The cut-off runs on every call, so a
     * repeated ban also catches a session that slipped through.
     */
    public function ban(User $user): void
    {
        $changed = DB::transaction(function () use ($user) {
            $locked = User::lockForUpdate()->findOrFail($user->id);
            if ($locked->isBanned()) {
                return false;
            }
            $locked->forceFill(['banned_at' => now()])->save();

            return true;
        });
        $user->refresh();

        $this->sessions->destroyAll($user);
        $this->presence->forget($user->id);
        UserBanned::dispatch($user);

        if ($changed) {
            $this->audit->record(AuditLogger::USER_BANNED, $user);
        }
    }

    public function unban(User $user): void
    {
        $changed = User::whereKey($user->id)->whereNotNull('banned_at')->update(['banned_at' => null]) > 0;
        $user->refresh();

        if ($changed) {
            $this->audit->record(AuditLogger::USER_UNBANNED, $user);
        }
    }

    /**
     * The message becomes a tombstone for everyone (broadcast), then its files are deleted,
     * objects first. Returns false when some file could not be deleted: it stays attached to
     * the tombstone (so nobody can download it) and calling again retries.
     */
    public function deleteMessage(Message $message): bool
    {
        $deleted = DB::transaction(function () use ($message) {
            $locked = Message::lockForUpdate()->findOrFail($message->id);
            if ($locked->isDeleted()) {
                return false;
            }
            $locked->forceFill(['deleted_at' => now()])->save();
            MessageDeleted::dispatch($locked);

            return true;
        });

        if ($deleted) {
            $this->audit->record(AuditLogger::MESSAGE_MODERATED_DELETE, $message);
        }

        return $this->files->deleteMany(File::where('message_id', $message->id)->pluck('id')) === [];
    }

    /**
     * Object first, then the row (false, and nothing changed, when object storage refuses).
     * The message that carried the file is pushed again without it; one left with neither
     * body nor file becomes a tombstone.
     */
    public function deleteFile(File $file): bool
    {
        if (! $this->files->delete($file->id)) {
            return false;
        }
        $this->audit->record(AuditLogger::FILE_MODERATED_DELETE, $file);

        if ($file->message_id !== null) {
            DB::transaction(function () use ($file) {
                $message = Message::lockForUpdate()->find($file->message_id);
                if ($message === null || $message->isDeleted()) {
                    return;
                }
                if ($message->body === '' && ! $message->files()->exists()) {
                    $message->forceFill(['deleted_at' => now()])->save();
                    MessageDeleted::dispatch($message);
                } else {
                    MessageUpdated::dispatch($message);
                }
            });
        }

        return true;
    }

    /** Locked: members still read; only administrators post, react or edit (ChannelPolicy::post). */
    public function setLocked(Channel $channel, bool $locked): void
    {
        $query = Channel::whereKey($channel->id);
        $changed = ($locked
            ? $query->whereNull('locked_at')->update(['locked_at' => now()])
            : $query->whereNotNull('locked_at')->update(['locked_at' => null])) > 0;
        $channel->refresh();

        if ($changed) {
            $this->audit->record($locked ? AuditLogger::CHANNEL_LOCKED : AuditLogger::CHANNEL_UNLOCKED, $channel);
        }
    }
}
