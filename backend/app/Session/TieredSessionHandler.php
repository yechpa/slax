<?php

namespace App\Session;

use Illuminate\Contracts\Cache\Repository as CacheContract;
use Illuminate\Session\CacheBasedSessionHandler;

/**
 * The Redis session store (SESSION_DRIVER=redis-tiered), with two lifetimes:
 *
 *  - a session with someone signed in (it holds the guard's `login_<guard>_<sha1>` key) is kept
 *    for `session.lifetime` (14 days), renewed by every request, so a notification tapped after
 *    a quiet week does not land on the sign-in screen;
 *  - any other session (a visitor of the public demo or a crawler calling the API, the CSRF
 *    cookie, a sign-in on its way to Google, the fresh session after a sign-out) for
 *    `session.guest_lifetime` (2 hours) at most, so anonymous traffic cannot fill Redis, which
 *    also holds the queue.
 *
 * A request that signs in writes its session at its end, with the key: the long lifetime from
 * then on. The data is serialized PHP (`session.encrypt` stays off: an encrypted payload would
 * hide the key, see AppServiceProvider). The cookie keeps the long lifetime; a guest's id the
 * store has forgotten is simply a new, empty session.
 */
class TieredSessionHandler extends CacheBasedSessionHandler
{
    /** The session guard's key (SessionGuard::getName()), as it appears in the serialized payload. */
    private const SIGNED_IN = '/"login_[A-Za-z0-9_-]+_[0-9a-f]{40}"/';

    public function __construct(CacheContract $cache, int $minutes, private readonly int $guestMinutes)
    {
        parent::__construct($cache, $minutes);
    }

    public function write($sessionId, $data): bool
    {
        $minutes = preg_match(self::SIGNED_IN, $data) === 1 ? $this->minutes : min($this->minutes, $this->guestMinutes);

        return $this->cache->put($sessionId, $data, max(1, $minutes) * 60);
    }
}
