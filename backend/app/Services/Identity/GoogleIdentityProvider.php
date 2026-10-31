<?php

namespace App\Services\Identity;

use App\Contracts\IdentityProvider;
use Laravel\Socialite\Facades\Socialite;
use Laravel\Socialite\Two\GoogleProvider;
use Throwable;

/**
 * Google OpenID Connect (authorization code flow) on top of Socialite.
 *
 * Socialite runs stateless: the `state` is generated and checked by us (kept in
 * the session), and the `nonce` is verified here against the ID token that
 * Google returned from the token endpoint over TLS.
 */
class GoogleIdentityProvider implements IdentityProvider
{
    private const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

    public function authorizationUrl(string $state, string $nonce): string
    {
        return $this->driver()->with(['state' => $state, 'nonce' => $nonce])->redirect()->getTargetUrl();
    }

    public function exchange(string $code, string $nonce): GoogleProfile
    {
        try {
            $response = $this->driver()->getAccessTokenResponse($code);
        } catch (Throwable $e) {
            throw new IdentityProviderException('Google refused the authorization code.', previous: $e);
        }

        return self::profileFromTokenResponse($response, $nonce);
    }

    /**
     * @param  array<string, mixed>  $response  body of Google's token endpoint
     *
     * @throws IdentityProviderException
     */
    public static function profileFromTokenResponse(array $response, string $nonce): GoogleProfile
    {
        $claims = self::decodeIdToken($response['id_token'] ?? null);

        $valid = in_array($claims['iss'] ?? null, self::ISSUERS, true)
            && ($claims['aud'] ?? null) === config('services.google.client_id')
            && (int) ($claims['exp'] ?? 0) > time()
            && is_string($claims['nonce'] ?? null)
            && hash_equals($nonce, $claims['nonce'])
            && is_string($claims['sub'] ?? null) && $claims['sub'] !== ''
            && is_string($claims['email'] ?? null) && $claims['email'] !== '';

        if (! $valid) {
            throw new IdentityProviderException('Invalid ID token.');
        }

        return new GoogleProfile(
            sub: $claims['sub'],
            email: $claims['email'],
            emailVerified: filter_var($claims['email_verified'] ?? false, FILTER_VALIDATE_BOOLEAN),
            name: is_string($claims['name'] ?? null) && $claims['name'] !== '' ? $claims['name'] : $claims['email'],
            avatar: is_string($claims['picture'] ?? null) ? $claims['picture'] : null,
        );
    }

    /**
     * The token comes straight from Google's token endpoint over TLS, which is
     * enough to trust it (OIDC Core 3.1.3.7): the signature is not re-checked.
     *
     * @return array<string, mixed>
     */
    private static function decodeIdToken(mixed $idToken): array
    {
        $parts = is_string($idToken) ? explode('.', $idToken) : [];
        $claims = count($parts) === 3
            ? json_decode((string) base64_decode(strtr($parts[1], '-_', '+/')), true)
            : null;

        if (! is_array($claims)) {
            throw new IdentityProviderException('Missing or malformed ID token.');
        }

        return $claims;
    }

    private function driver(): GoogleProvider
    {
        /** @var GoogleProvider */
        return Socialite::driver('google')->stateless();
    }
}
