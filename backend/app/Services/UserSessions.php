<?php

namespace App\Services;

use App\Models\User;
use Illuminate\Contracts\Redis\Factory as RedisFactory;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Which sessions a user holds, so that a ban can end all of them at once.
 *
 * The session store (Redis) is keyed by session id only, so the ids are indexed per user in
 * a Redis set at sign-in. Ending them destroys each one in the session store itself; on top
 * of that, EnsureNotBanned refuses any request from a banned user, so a session missed here
 * (signed in before this index existed) is still useless. Slax has no API tokens.
 */
class UserSessions
{
    public function __construct(private readonly RedisFactory $redis) {}

    public function remember(User $user, string $sessionId): void
    {
        $key = self::key($user->id);
        // Long enough for any session of the set: the lifetime is renewed on activity.
        $ttl = max(1, (int) config('session.lifetime', 120)) * 60 * 2;

        try {
            $redis = $this->redis->connection();
            $redis->sadd($key, $sessionId);
            $redis->expire($key, $ttl);
        } catch (Throwable $e) {
            report($e);
        }
    }

    public function forget(User $user, string $sessionId): void
    {
        try {
            $this->redis->connection()->srem(self::key($user->id), $sessionId);
        } catch (Throwable $e) {
            report($e);
        }
    }

    /** Ends every known session of the user. Returns how many were destroyed. */
    public function destroyAll(User $user): int
    {
        $handler = app('session')->driver()->getHandler();
        $redis = $this->redis->connection();
        $ids = (array) $redis->smembers(self::key($user->id));

        foreach ($ids as $id) {
            $handler->destroy((string) $id);
        }
        $redis->del(self::key($user->id));

        // The database store also knows sessions by user.
        if (config('session.driver') === 'database') {
            DB::table((string) config('session.table', 'sessions'))->where('user_id', $user->id)->delete();
        }

        return count($ids);
    }

    /**
     * A signed-out session stays ended. Laravel saves the session at the end of every request,
     * so a request that was in flight during the sign-out (a presence poll) writes the old,
     * signed-in session back after the logout destroyed it; EnsureNotBanned refuses any session
     * marked here. Kept for a session's lifetime (it could not outlive it anyway).
     */
    public function end(string $sessionId): void
    {
        try {
            $this->redis->connection()->setex(self::endedKey($sessionId), max(1, (int) config('session.lifetime', 120)) * 60, '1');
        } catch (Throwable $e) {
            report($e);
        }
    }

    public function ended(string $sessionId): bool
    {
        try {
            return (bool) $this->redis->connection()->exists(self::endedKey($sessionId));
        } catch (Throwable $e) {
            // Redis down: sessions (stored there too) are gone anyway.
            report($e);

            return false;
        }
    }

    private static function endedKey(string $sessionId): string
    {
        return 'session-ended:'.hash('sha256', $sessionId);
    }

    private static function key(int $userId): string
    {
        return "user-sessions:{$userId}";
    }
}
