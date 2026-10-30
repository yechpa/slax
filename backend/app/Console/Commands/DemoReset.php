<?php

namespace App\Console\Commands;

use App\Contracts\AdminNotifier;
use App\Jobs\TerminateUserConnections;
use App\Models\Channel;
use App\Models\File;
use App\Models\Message;
use App\Models\Reaction;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\PresenceService;
use App\Services\StoredFiles;
use App\Services\UserSessions;
use Database\Seeders\DefaultWorkspaceSeeder;
use Database\Seeders\DemoSeeder;
use Illuminate\Console\Command;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * The nightly reset of the public demo (scheduled at 03:00 Asia/Jerusalem, routes/console.php).
 *
 * Off unless SLAX_DEMO_RESET_ENABLED is true (the public showcase only), or with --force.
 *
 * Demo accounts are the ones visitors signed up with (`account_type = demo`), never an
 * administrator (flag or ADMIN_EMAILS address), a `member` or a `seed` account.
 *
 *  1. Demo content goes: every message and reaction of a demo account, the channels demo
 *     accounts created, and the conversations a demo account is part of.
 *  2. Demo accounts without activity (last seen, or created) for 7 days are deleted;
 *     active ones are kept, with their memberships, and so are banned ones (deleting them
 *     would undo the ban: the person could sign up again).
 *  3. The starter channels and the seed messages are restored (DemoSeeder).
 *
 * Files are deleted object first, then row (StoredFiles). An object that cannot be deleted
 * keeps its row, and with it the channel and account it belongs to (the foreign keys would
 * refuse anyway), and the kept channel's creator, until the next run; the command then exits
 * with a failure. Deleted accounts lose their sessions, presence and sockets, last, after the
 * seed is restored and the run audited. Running it twice changes nothing more.
 */
class DemoReset extends Command
{
    protected $signature = 'slax:demo-reset {--force : Run even where SLAX_DEMO_RESET_ENABLED is off}';

    protected $description = 'Reset the public demo: visitors\' content, expired demo accounts, seed content';

    public function handle(
        StoredFiles $files,
        UserSessions $sessions,
        PresenceService $presence,
        AuditLogger $audit,
        AdminNotifier $notifier,
    ): int {
        if (! config('slax.demo.reset_enabled') && ! $this->option('force')) {
            $this->error('The demo reset is off here: it deletes visitors\' accounts and content. '
                .'Set SLAX_DEMO_RESET_ENABLED=true (the public showcase only), or pass --force.');

            return self::FAILURE;
        }

        $demoIds = $this->demoAccountIds();
        $cutoff = now()->subDays((int) config('slax.demo.inactive_days', 7));
        // A banned account is kept: deleting it would let the person sign up again.
        $expiredIds = User::whereKey($demoIds)
            ->whereNull('banned_at')
            ->whereRaw('coalesce(last_seen_at, created_at) < ?', [$cutoff])
            ->pluck('id');

        $channelIds = $this->demoChannelIds($demoIds);
        $messageIds = Message::where(fn ($query) => $query->whereIn('user_id', $demoIds)->orWhereIn('channel_id', $channelIds))->pluck('id');
        // Replies go with their thread (foreign key cascade), and their files with them.
        $threadIds = $messageIds->merge(Message::whereIn('parent_id', $messageIds)->pluck('id'))->unique();
        $fileIds = File::where(fn ($query) => $query
            ->whereIn('user_id', $expiredIds)
            ->orWhereIn('channel_id', $channelIds)
            ->orWhereIn('message_id', $threadIds))
            ->pluck('id');

        $failedIds = $files->deleteMany($fileIds);
        $failed = File::whereKey($failedIds)->get(['id', 'user_id', 'channel_id']);
        $deletableChannelIds = $channelIds->diff($failed->pluck('channel_id'))->values();
        // A channel kept for the next run keeps its creator too: deleted, the creator would leave
        // it without one, and it would never be recognised as demo content again.
        $keptCreators = Channel::whereKey($channelIds->diff($deletableChannelIds))->whereNotNull('created_by')->pluck('created_by');
        $deletableUserIds = $expiredIds->diff($failed->pluck('user_id'))->diff($keptCreators)->values();

        [$counts, $deletedUsers] = DB::transaction(function () use ($demoIds, $messageIds, $deletableChannelIds, $deletableUserIds) {
            // Belt and braces: the same guards as above, again at the last moment, under lock.
            $users = User::whereKey($deletableUserIds)
                ->where('account_type', User::ACCOUNT_DEMO)
                ->where('is_admin', false)
                ->whereNull('banned_at')
                ->lockForUpdate()
                ->get();

            return [[
                'deleted_messages' => Message::whereKey($messageIds)->delete(),
                'deleted_reactions' => Reaction::whereIn('user_id', $demoIds)->delete(),
                'deleted_channels' => Channel::whereKey($deletableChannelIds)->delete(),
                'deleted_users' => User::whereKey($users->modelKeys())->delete(),
            ], $users];
        });

        (new DemoSeeder)->run();

        $summary = $counts + [
            'deleted_files' => $fileIds->count() - count($failedIds),
            'failed_files' => count($failedIds),
            'kept_users' => $demoIds->count() - $counts['deleted_users'],
        ];
        $audit->record(AuditLogger::DEMO_RESET);
        Log::info('Demo reset.', $summary);
        $this->info('Demo reset: '.collect($summary)->map(fn ($value, $key) => "{$key}={$value}")->implode(', '));
        $notifier->notify($failedIds === [] ? 'info' : 'warning', 'Demo reset', $summary);

        // Last, and failure-proof: the accounts actually deleted lose their sessions, presence and sockets.
        foreach ($deletedUsers as $user) {
            try {
                $sessions->destroyAll($user);
                $presence->forget($user->id);
            } catch (Throwable $e) {
                report($e);
            }
            TerminateUserConnections::now($user->id);
        }

        if ($failedIds !== []) {
            $this->error(count($failedIds).' object(s) could not be deleted; their rows, channels and accounts wait for the next run.');

            return self::FAILURE;
        }

        return self::SUCCESS;
    }

    /** @return Collection<int, int> */
    private function demoAccountIds(): Collection
    {
        $adminEmails = (array) config('slax.admin_emails', []);

        return User::where('account_type', User::ACCOUNT_DEMO)
            ->where('is_admin', false)
            ->when($adminEmails !== [], fn ($query) => $query->whereRaw('lower(email) not in ('.implode(',', array_fill(0, count($adminEmails), '?')).')', $adminEmails))
            ->pluck('id');
    }

    /**
     * Channels created by demo accounts, other than the starter ones (a demo account's
     * channels go in the run that deletes the account, so none is left without a creator),
     * and conversations with a demo account in them.
     *
     * @param  Collection<int, int>  $demoIds
     * @return Collection<int, int>
     */
    private function demoChannelIds(Collection $demoIds): Collection
    {
        return Channel::where(fn ($query) => $query
            ->whereIn('kind', [Channel::KIND_PUBLIC, Channel::KIND_PRIVATE])
            ->whereNotIn('name', array_keys(DefaultWorkspaceSeeder::CHANNELS))
            ->whereIn('created_by', $demoIds))
            ->orWhere(fn ($query) => $query
                ->whereIn('kind', [Channel::KIND_DM, Channel::KIND_GROUP_DM])
                ->whereHas('members', fn ($members) => $members->whereIn('users.id', $demoIds)))
            ->pluck('id');
    }
}
