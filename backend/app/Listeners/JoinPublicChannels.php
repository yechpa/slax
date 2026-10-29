<?php

namespace App\Listeners;

use App\Events\UserRegistered;
use App\Models\Channel;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;

/** A new user lands in every public channel of the default workspace. */
class JoinPublicChannels
{
    public function handle(UserRegistered $event): void
    {
        $workspace = Workspace::where('slug', Workspace::DEFAULT_SLUG)->first();
        if ($workspace === null) {
            return;
        }

        $now = now();
        $rows = Channel::where('workspace_id', $workspace->id)
            ->where('kind', Channel::KIND_PUBLIC)
            ->pluck('id')
            ->map(fn (int $channelId) => [
                'channel_id' => $channelId,
                'user_id' => $event->user->id,
                'role' => Channel::ROLE_MEMBER,
                'created_at' => $now,
                'updated_at' => $now,
            ])->all();

        DB::table('channel_members')->insertOrIgnore($rows);
    }
}
