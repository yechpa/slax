<?php

use App\Contracts\IdentityProvider;
use App\Providers\AppServiceProvider;
use App\Services\Identity\E2eIdentityProvider;
use App\Services\Identity\GoogleIdentityProvider;

/**
 * Which identity provider the application binds, per APP_ENV. The stand-in for Google signs
 * anybody in, so it must only ever exist in the end-to-end stack.
 */
function identityProviderUnder(string $environment): IdentityProvider
{
    app()['env'] = $environment;
    (new AppServiceProvider(app()))->register();
    app()->forgetInstance(IdentityProvider::class);

    return app(IdentityProvider::class);
}

test('the real google provider is bound in every environment but e2e', function (string $environment) {
    expect(identityProviderUnder($environment))->toBeInstanceOf(GoogleIdentityProvider::class);
})->with(['production', 'local', 'testing', 'staging']);

test('the end-to-end provider is bound only under APP_ENV=e2e', function () {
    expect(identityProviderUnder('e2e'))->toBeInstanceOf(E2eIdentityProvider::class);
});

test('the test application itself signs in through the real provider unless a test fakes it', function () {
    expect(app(IdentityProvider::class))->toBeInstanceOf(GoogleIdentityProvider::class);
});

test('the end-to-end provider refuses to be built outside e2e', function (string $environment) {
    app()['env'] = $environment;

    expect(fn () => new E2eIdentityProvider(app()))->toThrow(LogicException::class);
})->with(['production', 'local', 'testing']);
