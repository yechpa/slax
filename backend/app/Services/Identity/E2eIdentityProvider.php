<?php

namespace App\Services\Identity;

use App\Contracts\IdentityProvider;
use Illuminate\Contracts\Foundation\Application;
use LogicException;

/**
 * Stand-in for Google in the end-to-end stack (`make e2e`), bound only when APP_ENV is `e2e`
 * (see AppServiceProvider). It refuses to exist in any other environment.
 *
 * The browser goes through the same steps as with Google: the SPA's "Continue with Google"
 * leads to an account chooser (E2eSignInController, standing in for Google's consent page)
 * where the test types who it is; the chooser sends the browser back to the real callback
 * with a code that carries that identity and the nonce, which `exchange` checks like Google.
 */
final class E2eIdentityProvider implements IdentityProvider
{
    public function __construct(Application $app)
    {
        if (! $app->environment('e2e')) {
            throw new LogicException('The end-to-end identity provider only exists under APP_ENV=e2e.');
        }
    }

    public function authorizationUrl(string $state, string $nonce): string
    {
        return rtrim((string) config('app.url'), '/').'/auth/e2e/google?'.http_build_query([
            'state' => $state,
            'nonce' => $nonce,
        ]);
    }

    /**
     * The authorization code the chooser hands back: the identity and the nonce, base64url JSON.
     *
     * @param  array{email: string, name: string, email_verified: bool}  $identity
     */
    public static function code(array $identity, string $nonce): string
    {
        $json = json_encode($identity + ['nonce' => $nonce], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);

        return rtrim(strtr(base64_encode($json), '+/', '-_'), '=');
    }

    public function exchange(string $code, string $nonce): GoogleProfile
    {
        $claims = json_decode((string) base64_decode(strtr($code, '-_', '+/'), true), true);

        $valid = is_array($claims)
            && is_string($claims['email'] ?? null) && filter_var($claims['email'], FILTER_VALIDATE_EMAIL)
            && is_string($claims['name'] ?? null) && $claims['name'] !== ''
            && is_bool($claims['email_verified'] ?? null)
            && is_string($claims['nonce'] ?? null) && hash_equals($nonce, $claims['nonce']);

        if (! $valid) {
            throw new IdentityProviderException('Invalid end-to-end authorization code.');
        }

        $email = strtolower($claims['email']);

        return new GoogleProfile(
            sub: 'e2e:'.$email,
            email: $email,
            emailVerified: $claims['email_verified'],
            name: $claims['name'],
            avatar: null,
        );
    }
}
