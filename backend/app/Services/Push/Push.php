<?php

namespace App\Services\Push;

/**
 * Web Push settings (config/slax.php `push`): whether it is on, the public key, and which
 * endpoints a subscription may name.
 */
final class Push
{
    /** On with both VAPID keys and a subject; otherwise every push endpoint but DELETE is a 404. */
    public static function enabled(): bool
    {
        return self::publicKey() !== null
            && trim((string) config('slax.push.private_key')) !== ''
            && trim((string) config('slax.push.subject')) !== '';
    }

    public static function publicKey(): ?string
    {
        $key = trim((string) config('slax.push.public_key'));

        return $key === '' ? null : $key;
    }

    /** Short fingerprint of the public key a subscription is made with (a rotation changes it). */
    public static function keyId(): ?string
    {
        $key = self::publicKey();

        return $key === null ? null : substr(hash('sha256', $key), 0, 16);
    }

    /**
     * An https URL on the default port, without user info, whose host is one of
     * `slax.push.allowed_hosts` (exactly, or under one starting with a dot).
     */
    public static function allowsEndpoint(string $url): bool
    {
        $parts = parse_url($url);
        if ($parts === false || ($parts['scheme'] ?? null) !== 'https' || ! isset($parts['host'])
            || isset($parts['user']) || isset($parts['pass']) || (isset($parts['port']) && $parts['port'] !== 443)) {
            return false;
        }
        $host = strtolower($parts['host']);

        foreach ((array) config('slax.push.allowed_hosts', []) as $allowed) {
            $allowed = strtolower((string) $allowed);
            if (str_starts_with($allowed, '.') ? str_ends_with($host, $allowed) && strlen($host) > strlen($allowed) : $host === $allowed) {
                return true;
            }
        }

        return false;
    }
}
