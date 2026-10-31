<?php

use App\Contracts\IdentityProvider;
use App\Models\User;
use App\Services\Identity\E2eIdentityProvider;
use App\Services\Identity\IdentityProviderException;
use Illuminate\Foundation\Http\Middleware\ValidateCsrfToken;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * The end-to-end stack's stand-in for Google: an account chooser that hands the real callback
 * a code carrying the identity and the nonce. Registered and bound only under APP_ENV=e2e.
 */
function asE2eStack(): void
{
    app()['env'] = 'e2e';
    // Laravel skips the CSRF check only while APP_ENV is `testing`.
    test()->withoutMiddleware(ValidateCsrfToken::class);
    app()->instance(IdentityProvider::class, new E2eIdentityProvider(app()));
    Route::middleware('web')->group(base_path('routes/web.php'));
    app('router')->getRoutes()->refreshNameLookups();
}

/** POST start through the SPA's origin; returns the {state, nonce} kept in the session. */
function e2eStart(): array
{
    test()->withHeaders(['Referer' => 'http://localhost/'])
        ->postJson('/api/v1/auth/google/start', ['turnstile_token' => 'ok'])->assertOk();

    return session('google_oauth');
}

test('the account chooser does not exist outside the e2e stack', function () {
    test()->get('/auth/e2e/google?state=s&nonce=n')->assertNotFound();
    test()->get('/auth/e2e/google/approve?state=s&nonce=n&email=a@b.test&name=A')->assertNotFound();
});

test('outside the e2e stack the chooser routes are not registered at all (not merely refused)', function () {
    $chooserRoutes = fn () => collect(Route::getRoutes()->getRoutes())->map->uri()
        ->filter(fn (string $uri) => str_starts_with($uri, 'auth/e2e'))->sort()->values()->all();

    // As booted for the tests (APP_ENV=testing), then loaded again under other environments.
    expect($chooserRoutes())->toBe([]);
    foreach (['production', 'local', 'staging'] as $environment) {
        app()['env'] = $environment;
        Route::middleware('web')->group(base_path('routes/web.php'));
        expect($chooserRoutes(), $environment)->toBe([]);
    }
    // The router itself answers 404 (no route), before any controller.
    expect(fn () => Route::getRoutes()->match(Request::create('/auth/e2e/google')))->toThrow(NotFoundHttpException::class);

    // Under e2e they are there: the check above can see them.
    app()['env'] = 'e2e';
    Route::middleware('web')->group(base_path('routes/web.php'));
    expect($chooserRoutes())->toBe(['auth/e2e/google', 'auth/e2e/google/approve']);
});

test('the account chooser refuses to answer if the environment is not e2e, even when routed', function () {
    asE2eStack();
    app()['env'] = 'production';

    test()->get('/auth/e2e/google?state=s&nonce=n')->assertNotFound();
    test()->get('/auth/e2e/google/approve?state=s&nonce=n&email=a@b.test&name=A')->assertNotFound();
});

test('start sends the browser to the account chooser with the state and nonce', function () {
    asE2eStack();

    $response = test()->withHeaders(['Referer' => 'http://localhost/'])
        ->postJson('/api/v1/auth/google/start', ['turnstile_token' => 'ok'])->assertOk();
    $oauth = session('google_oauth');

    expect($response->json('redirect_url'))
        ->toBe(rtrim(config('app.url'), '/').'/auth/e2e/google?'.http_build_query(['state' => $oauth['state'], 'nonce' => $oauth['nonce']]));

    test()->get('/auth/e2e/google?'.http_build_query($oauth))
        ->assertOk()
        ->assertSee('name="email"', false)
        ->assertSee('value="'.$oauth['state'].'"', false);
});

test('choosing an account signs it in through the real callback', function () {
    asE2eStack();
    $oauth = e2eStart();

    $approve = test()->get('/auth/e2e/google/approve?'.http_build_query($oauth + [
        'email' => 'Dana@Example.test', 'name' => 'Dana', 'email_verified' => '1',
    ]));
    $approve->assertRedirectContains('/auth/google/callback?code=');

    test()->get($approve->headers->get('Location'))->assertRedirect('/');

    $user = User::sole();
    expect($user->email)->toBe('dana@example.test')
        ->and($user->name)->toBe('Dana')
        ->and($user->google_sub)->toBe('e2e:dana@example.test');
    test()->assertAuthenticatedAs($user, 'web');
});

test('an unverified address is refused like a google one', function () {
    asE2eStack();
    $oauth = e2eStart();

    $approve = test()->get('/auth/e2e/google/approve?'.http_build_query($oauth + ['email' => 'noam@example.test', 'name' => 'Noam']));

    test()->get($approve->headers->get('Location'))->assertRedirect('/?auth_error=email_unverified');
    expect(User::count())->toBe(0);
});

test('the code is bound to the nonce of the sign-in it was made for', function () {
    $provider = new E2eIdentityProvider(tap(app(), fn ($app) => $app['env'] = 'e2e'));
    $code = E2eIdentityProvider::code(['email' => 'a@example.test', 'name' => 'A', 'email_verified' => true], 'nonce-1');

    expect($provider->exchange($code, 'nonce-1')->email)->toBe('a@example.test')
        ->and(fn () => $provider->exchange($code, 'nonce-2'))->toThrow(IdentityProviderException::class)
        ->and(fn () => $provider->exchange('not-a-code', 'nonce-1'))->toThrow(IdentityProviderException::class);
});
