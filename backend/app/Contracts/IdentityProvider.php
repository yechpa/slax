<?php

namespace App\Contracts;

use App\Services\Identity\GoogleProfile;
use App\Services\Identity\IdentityProviderException;

/**
 * OpenID Connect login. The real implementation talks to Google; tests and
 * E2E runs use a fake (see AppServiceProvider).
 */
interface IdentityProvider
{
    /** URL the browser is sent to; `state` and `nonce` come back to us signed or echoed. */
    public function authorizationUrl(string $state, string $nonce): string;

    /**
     * Exchanges the authorization code and returns the verified profile.
     *
     * @throws IdentityProviderException when the code is refused or the nonce does not match
     */
    public function exchange(string $code, string $nonce): GoogleProfile;
}
