<?php

namespace App\Services;

use App\Enums\PresenceState;
use App\Models\User;
use Illuminate\Contracts\Redis\Factory as RedisFactory;
use Illuminate\Redis\Connections\Connection;
use Illuminate\Support\Carbon;

/**
 * Who is online, away or offline, derived from Redis; nothing is written to the database.
 *
 * Client contract (the SPA):
 *  - every 25 s, `POST /api/v1/presence/heartbeat {"active": bool}`, `active` being true when the
 *    user interacted with the app in the last 5 minutes (background tabs keep pinging with false);
 *  - every 30 s, `GET /api/v1/presence?user_ids[]=…` (up to 200 ids) for the people on screen:
 *    `{"<id>": "online|away|offline"}`. State changes are not pushed; joins and leaves also arrive
 *    on the presence channel `presence-workspace.{id}`;
 *  - typing: the client whispers `client-typing` on the private `channel.{id}` it has open. Reverb
 *    relays it to the other subscribers of that channel only, tagged with the sender's `user_id`.
 *
 * Redis keys, both holding the time of the ping as epoch seconds:
 *  - `presence:{user}`, TTL 60 s, refreshed by every heartbeat: alive means connected;
 *  - `presence:active:{user}`, TTL 5 min, refreshed by heartbeats with `active`: the last interaction.
 *
 * online = connected and interacted less than 5 minutes ago; away = connected without a recent
 * interaction; offline = no heartbeat for 60 s, or banned. The stored times are checked against the
 * application clock as well as the TTLs, so tests can move time with Carbon::setTestNow().
 */
class PresenceService
{
    /** Heartbeats come every 25 s: two missed pings and a bit of network jitter before "offline". */
    public const CONNECTION_TTL = 60;

    /** Without an interaction for this long, a connected user is "away". */
    public const AWAY_AFTER = 300;

    public function __construct(private readonly RedisFactory $redis) {}

    public function heartbeat(int $userId, bool $active): void
    {
        $now = Carbon::now()->getTimestamp();

        $this->redis()->pipeline(function ($pipe) use ($userId, $active, $now): void {
            $pipe->setex(self::connectionKey($userId), self::CONNECTION_TTL, $now);
            if ($active) {
                $pipe->setex(self::activeKey($userId), self::AWAY_AFTER, $now);
            }
        });
    }

    /** The user shows offline at once (a ban; the sockets are closed separately). */
    public function forget(int $userId): void
    {
        $this->redis()->del(self::connectionKey($userId), self::activeKey($userId));
    }

    /** One of PresenceState's values. */
    public function stateOf(int $userId): string
    {
        return $this->statesOf([$userId])[$userId];
    }

    /**
     * One Redis round trip (MGET) and one database query for any number of users, no matter how
     * many. Ids nobody has pinged for are offline; so are banned users, whatever Redis says.
     *
     * @param  list<int>  $userIds
     * @return array<int, string> state per user id
     */
    public function statesOf(array $userIds): array
    {
        $userIds = array_values(array_unique(array_map('intval', $userIds)));
        if ($userIds === []) {
            return [];
        }

        $keys = [];
        foreach ($userIds as $id) {
            $keys[] = self::connectionKey($id);
            $keys[] = self::activeKey($id);
        }
        $values = $this->redis()->mget($keys);
        $banned = array_flip(User::whereIn('id', $userIds)->whereNotNull('banned_at')->pluck('id')->all());
        $now = Carbon::now()->getTimestamp();

        $states = [];
        foreach ($userIds as $i => $id) {
            $state = isset($banned[$id])
                ? PresenceState::Offline
                : $this->stateAt($now, $values[2 * $i], $values[2 * $i + 1]);
            $states[$id] = $state->value;
        }

        return $states;
    }

    private function stateAt(int $now, ?string $connectedAt, ?string $activeAt): PresenceState
    {
        if ($connectedAt === null || $now - (int) $connectedAt >= self::CONNECTION_TTL) {
            return PresenceState::Offline;
        }

        return $activeAt !== null && $now - (int) $activeAt < self::AWAY_AFTER
            ? PresenceState::Online
            : PresenceState::Away;
    }

    private function redis(): Connection
    {
        return $this->redis->connection();
    }

    private static function connectionKey(int $userId): string
    {
        return "presence:{$userId}";
    }

    private static function activeKey(int $userId): string
    {
        return "presence:active:{$userId}";
    }
}
