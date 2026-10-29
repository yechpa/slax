<?php

namespace App\Services\Identity;

use App\Contracts\IdentityProvider;
use Throwable;

/**
 * Stand-in for Google, bound only when APP_ENV is `testing` or `e2e`.
 *
 * Without configuration it derives a verified profile from the code: a code
 * holding an "@" is used as the e-mail address (E2E: .../callback?code=a@b.test).
 */
class FakeIdentityProvider implements IdentityProvider
{
    public ?string $receivedCode = null;

    public ?string $receivedNonce = null;

    private ?GoogleProfile $profile = null;

    private ?Throwable $failure = null;

    private ?string $expectedNonce = null;

    public function returns(GoogleProfile $profile): static
    {
        $this->profile = $profile;
        $this->failure = null;

        return $this;
    }

    public function throws(Throwable $failure): static
    {
        $this->failure = $failure;

        return $this;
    }

    /** Like Google would: refuse when the nonce we send is not the one that was signed. */
    public function expectNonce(string $nonce): static
    {
        $this->expectedNonce = $nonce;

        return $this;
    }

    public function authorizationUrl(string $state, string $nonce): string
    {
        return rtrim((string) config('app.url'), '/').'/auth/google/callback?'.http_build_query([
            'code' => 'e2e-user@example.test',
            'state' => $state,
            'nonce' => $nonce,
        ]);
    }

    public function exchange(string $code, string $nonce): GoogleProfile
    {
        $this->receivedCode = $code;
        $this->receivedNonce = $nonce;

        if ($this->failure) {
            throw $this->failure;
        }
        if ($this->expectedNonce !== null && ! hash_equals($this->expectedNonce, $nonce)) {
            throw new IdentityProviderException('Nonce mismatch.');
        }

        return $this->profile ?? new GoogleProfile(
            sub: 'fake-'.sha1($code),
            email: str_contains($code, '@') ? $code : $code.'@example.test',
            emailVerified: true,
            name: ucfirst(strtok($code, '@')),
            avatar: null,
        );
    }
}
