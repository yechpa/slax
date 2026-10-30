<?php

namespace App\Services;

use App\Models\Channel;
use App\Models\User;
use Illuminate\Contracts\Database\Query\Expression;
use Illuminate\Support\Facades\DB;

/**
 * Where each member stopped reading a channel's timeline (`channel_members.last_read_message_id`)
 * and how many messages are new since then. Unread means: top-level, not deleted, written by
 * someone else, with an id above the pointer. Thread replies and tombstones never count.
 */
class ReadState
{
    /**
     * Two queries whatever the number of channels. Channels the user is not a member of get
     * no pointer and nothing unread.
     *
     * @param  list<int>  $channelIds
     * @return array<int, array{last_read_message_id: ?int, unread_count: int}>
     */
    public static function forChannels(User $user, array $channelIds): array
    {
        if ($channelIds === []) {
            return [];
        }

        $pointers = DB::table('channel_members')
            ->where('user_id', $user->id)
            ->whereIn('channel_id', $channelIds)
            ->pluck('last_read_message_id', 'channel_id');

        // Served by the (channel_id, parent_id, id) index of messages.
        $unread = DB::table('messages')
            ->join('channel_members', fn ($join) => $join
                ->on('channel_members.channel_id', '=', 'messages.channel_id')
                ->where('channel_members.user_id', '=', $user->id))
            ->whereIn('messages.channel_id', $channelIds)
            ->whereNull('messages.parent_id')
            ->whereNull('messages.deleted_at')
            ->where('messages.user_id', '<>', $user->id)
            ->whereRaw('messages.id > coalesce(channel_members.last_read_message_id, 0)')
            ->groupBy('messages.channel_id')
            ->selectRaw('messages.channel_id, count(*) as unread')
            ->pluck('unread', 'channel_id');

        $states = [];
        foreach ($channelIds as $id) {
            $pointer = $pointers[$id] ?? null;
            $states[$id] = [
                'last_read_message_id' => $pointer === null ? null : (int) $pointer,
                'unread_count' => (int) ($unread[$id] ?? 0),
            ];
        }

        return $states;
    }

    /** Moves the pointer forward only: an older id (a slow request, another tab) is a no-op. */
    public static function markRead(User $user, Channel $channel, int $messageId): void
    {
        DB::table('channel_members')
            ->where('channel_id', $channel->id)
            ->where('user_id', $user->id)
            ->where(fn ($query) => $query->whereNull('last_read_message_id')->orWhere('last_read_message_id', '<', $messageId))
            ->update(['last_read_message_id' => $messageId]);
    }

    /**
     * The pointer a new member starts with: the channel's latest top-level message, so joining
     * (or being added) does not flood the sidebar with the whole history as unread.
     */
    public static function upToNow(int $channelId): Expression
    {
        return DB::raw('(SELECT max(id) FROM messages WHERE messages.channel_id = '.$channelId.' AND messages.parent_id IS NULL)');
    }
}
