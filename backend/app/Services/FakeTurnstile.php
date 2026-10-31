<?php

namespace App\Services;

/** Bound only when APP_ENV is `testing` or `e2e`: passes unless a test says otherwise. */
class FakeTurnstile extends Turnstile
{
    public bool $passes = true;

    public function verify(string $token, string $ip): bool
    {
        return $this->passes;
    }
}
