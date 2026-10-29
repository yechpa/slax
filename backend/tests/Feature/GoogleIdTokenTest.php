<?php

use App\Services\Identity\GoogleIdentityProvider;
use App\Services\Identity\IdentityProviderException;

function idToken(array $claims): string
{
    $b64 = fn (string $s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');

    return $b64('{"alg":"RS256"}').'.'.$b64(json_encode(array_merge([
        'iss' => 'https://accounts.google.com',
        'aud' => 'client-id',
        'sub' => '1234',
        'exp' => time() + 300,
        'nonce' => 'expected-nonce',
        'email' => 'a@example.com',
        'email_verified' => true,
        'name' => 'A',
        'picture' => 'https://img.example.test/a.png',
    ], $claims))).'.signature';
}

function profileFrom(array $claims, string $nonce = 'expected-nonce')
{
    config(['services.google.client_id' => 'client-id']);

    return GoogleIdentityProvider::profileFromTokenResponse(['id_token' => idToken($claims)], $nonce);
}

test('a valid id token becomes a profile', function () {
    $profile = profileFrom([]);

    expect($profile->sub)->toBe('1234')
        ->and($profile->email)->toBe('a@example.com')
        ->and($profile->emailVerified)->toBeTrue()
        ->and($profile->name)->toBe('A')
        ->and($profile->avatar)->toBe('https://img.example.test/a.png');
});

test('email_verified given as a string is understood', function () {
    expect(profileFrom(['email_verified' => 'true'])->emailVerified)->toBeTrue()
        ->and(profileFrom(['email_verified' => 'false'])->emailVerified)->toBeFalse()
        ->and(profileFrom(['email_verified' => null])->emailVerified)->toBeFalse();
});

test('id token with a wrong or missing nonce, audience, issuer or expiry is rejected', function (array $claims) {
    expect(fn () => profileFrom($claims))->toThrow(IdentityProviderException::class);
})->with([
    'wrong nonce' => [['nonce' => 'other']],
    'missing nonce' => [['nonce' => null]],
    'wrong audience' => [['aud' => 'someone-else']],
    'wrong issuer' => [['iss' => 'https://evil.example']],
    'expired' => [['exp' => time() - 10]],
    'no subject' => [['sub' => '']],
]);

test('a response without id token is rejected', function () {
    expect(fn () => GoogleIdentityProvider::profileFromTokenResponse(['access_token' => 'x'], 'n'))
        ->toThrow(IdentityProviderException::class);
});
