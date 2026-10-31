<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Throwable;

/** Cloudflare Turnstile server-side verification. Fails closed on any error. */
class Turnstile
{
    private const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

    public function verify(string $token, string $ip): bool
    {
        if ($token === '') {
            return false;
        }

        try {
            $response = Http::asForm()->timeout(5)->post(self::VERIFY_URL, [
                'secret' => (string) config('services.turnstile.secret'),
                'response' => $token,
                'remoteip' => $ip,
            ]);
        } catch (Throwable) {
            return false;
        }

        return $response->successful() && $response->json('success') === true;
    }
}
