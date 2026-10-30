<?php

namespace App\Http\Controllers;

use App\Http\Resources\ChannelResource;
use App\Models\Channel;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class DirectChannelController extends Controller
{
    public const MAX_PARTICIPANTS = 8;

    /**
     * Opens the conversation between the caller and `user_ids`: the existing channel
     * for that exact set of people (200), or a new dm / group_dm (201).
     */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'user_ids' => ['present', 'array'],
            'user_ids.*' => ['required', 'integer', 'min:1'],
        ]);

        $caller = $request->user();
        $participants = collect($data['user_ids'])->map(fn ($id) => (int) $id)->push($caller->id)->unique()->sort()->values();

        if ($participants->count() < 2 || $participants->count() > self::MAX_PARTICIPANTS) {
            return response()->json(['error' => 'invalid_participant_count'], 422);
        }

        // Unknown and banned ids get the same answer: it must not reveal which accounts exist or are banned.
        if (User::whereKey($participants)->whereNull('banned_at')->count() !== $participants->count()) {
            return response()->json(['error' => 'invalid_participants'], 422);
        }

        [$channel, $created] = $this->findOrCreate($participants->all(), $caller);
        $channel->load(['members' => fn ($members) => $members->orderBy('users.id')]);

        return ChannelResource::withMembership($channel, true)->response()->setStatusCode($created ? 201 : 200);
    }

    /**
     * Race-safe: the unique `dm_key` makes concurrent creators collide, the loser's
     * INSERT waits for the winner's commit, does nothing, and reads the winner's row.
     *
     * @param  list<int>  $ids  sorted participant ids, caller included
     * @return array{Channel, bool}
     */
    private function findOrCreate(array $ids, User $caller): array
    {
        $key = 'dm:'.implode(',', $ids);

        if ($channel = Channel::where('dm_key', $key)->first()) {
            return [$channel, false];
        }

        return DB::transaction(function () use ($key, $ids, $caller) {
            $now = now();
            $created = DB::table('channels')->insertOrIgnore([
                'workspace_id' => Workspace::default()->id,
                'kind' => count($ids) === 2 ? Channel::KIND_DM : Channel::KIND_GROUP_DM,
                'dm_key' => $key,
                'created_by' => $caller->id,
                'created_at' => $now,
                'updated_at' => $now,
            ]) > 0;

            $channel = Channel::where('dm_key', $key)->firstOrFail();

            if ($created) {
                DB::table('channel_members')->insert(array_map(fn (int $id) => [
                    'channel_id' => $channel->id,
                    'user_id' => $id,
                    'role' => Channel::ROLE_MEMBER,
                    'created_at' => $now,
                    'updated_at' => $now,
                ], $ids));
            }

            return [$channel, $created];
        });
    }
}
