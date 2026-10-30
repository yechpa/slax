<?php

namespace App\Providers;

use App\Broadcasting\ReverbBroadcaster;
use App\Contracts\AdminNotifier;
use App\Contracts\IdentityProvider;
use App\Http\Controllers\GoogleAuthController;
use App\Models\User;
use App\Services\Alerts\NotifierFactory;
use App\Services\FakeScannerClient;
use App\Services\FakeTurnstile;
use App\Services\Identity\E2eIdentityProvider;
use App\Services\Identity\GoogleIdentityProvider;
use App\Services\Push\FakeWebPushSender;
use App\Services\Push\VapidWebPushSender;
use App\Services\Push\WebPushSender;
use App\Services\ScannerClient;
use App\Services\Turnstile;
use App\Session\TieredSessionHandler;
use Illuminate\Broadcasting\BroadcastManager;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Session;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Bound by environment, never by a setting: the stand-in for Google exists only in the
        // end-to-end stack (APP_ENV=e2e). Every other environment, tests included, gets the real
        // provider (feature tests swap in their own fake explicitly). See IdentityBindingTest.
        $this->app->singleton(IdentityProvider::class, $this->app->environment('e2e') ? E2eIdentityProvider::class : GoogleIdentityProvider::class);
        // Cloudflare is never called from automated tests or E2E runs (the E2E browser gets a stub
        // widget configured with Cloudflare's always-pass test site key).
        $this->app->singleton(Turnstile::class, $this->app->environment(['testing', 'e2e']) ? FakeTurnstile::class : Turnstile::class);
        // The scanner runs in the compose stack, E2E runs included: only unit and feature tests fake it.
        $this->app->singleton(ScannerClient::class, $this->app->environment('testing') ? FakeScannerClient::class : ScannerClient::class);
        // No automated run (tests, the e2e stack) ever reaches a real push service.
        $this->app->singleton(WebPushSender::class, $this->app->environment(['testing', 'e2e']) ? FakeWebPushSender::class : VapidWebPushSender::class);
        // Telegram when configured (never in tests), nothing otherwise.
        $this->app->singleton(AdminNotifier::class, fn ($app) => NotifierFactory::make($app->environment()));
    }

    public function boot(): void
    {
        // Redis sessions with a short lifetime for guests (TieredSessionHandler); the same Redis
        // connection and cache store as Laravel's own `redis` driver.
        Session::extend('redis-tiered', function (Application $app) {
            $config = $app['config'];
            if ($config->get('session.encrypt')) {
                throw new \LogicException('SESSION_DRIVER=redis-tiered needs SESSION_ENCRYPT off: it reads who is signed in from the payload.');
            }
            $cache = clone $app['cache']->store($config->get('session.store') ?: 'redis');
            $cache->getStore()->setConnection($config->get('session.connection'));

            return new TieredSessionHandler($cache, (int) $config->get('session.lifetime'), (int) $config->get('session.guest_lifetime', 120));
        });

        // The API returns bare resources and arrays, not {"data": ...} envelopes.
        JsonResource::withoutWrapping();

        // Per IP. The end-to-end suite signs in dozens of users from one browser container.
        $signIns = $this->app->environment('e2e') ? 50 : 1;
        RateLimiter::for('auth-start', fn (Request $request) => Limit::perMinute(10 * $signIns)->by($request->ip()));
        // The callback is a browser navigation: a refusal goes back to the SPA, which explains it.
        RateLimiter::for('auth-callback', fn (Request $request) => Limit::perMinute(20 * $signIns)->by($request->ip())
            ->response(fn () => GoogleAuthController::failed('rate_limited')));
        RateLimiter::for('dms', fn (Request $request) => Limit::perMinute(20)->by('user:'.$request->user()->id));
        // One tab pings 2.4 times a minute; this leaves room for about eight.
        RateLimiter::for('presence-heartbeat', fn (Request $request) => Limit::perMinute(20)->by('user:'.$request->user()->id));
        RateLimiter::for('messages', fn (Request $request) => Limit::perMinute(30)->by('user:'.$request->user()->id));
        // Clients debounce (about one call a second while reading); this leaves room for several tabs.
        RateLimiter::for('reads', fn (Request $request) => Limit::perMinute(120)->by('user:'.$request->user()->id));
        // Clients debounce typing (250 ms) and abort stale searches: about four a second at most.
        RateLimiter::for('user-search', fn (Request $request) => Limit::perMinute(60)->by('user:'.$request->user()->id));
        RateLimiter::for('uploads', fn (Request $request) => Limit::perMinute(20)->by('user:'.$request->user()->id));
        // Turning notifications on or off on a device; the test button sends to every device.
        RateLimiter::for('push-subscriptions', fn (Request $request) => Limit::perMinute(20)->by('user:'.$request->user()->id));
        RateLimiter::for('push-test', fn (Request $request) => Limit::perMinute(3)->by('user:'.$request->user()->id));
        RateLimiter::for('admin-writes', fn (Request $request) => Limit::perMinute(30)->by('user:'.$request->user()->id));

        // Administrators are the ADMIN_EMAILS accounts (set at each sign-in); a banned one is not.
        Gate::define('admin', fn (User $user) => $user->is_admin && ! $user->isBanned());

        // Ids are bigints: anything else is a 404, not a database error.
        Route::pattern('channel', '[0-9]+');
        Route::pattern('message', '[0-9]+');
        Route::pattern('file', '[0-9]+');

        // Reverb speaks the Pusher protocol; this subclass adds what channel revocation needs.
        Broadcast::extend('reverb', fn ($app, array $config) => new ReverbBroadcaster($app->make(BroadcastManager::class)->pusher($config)));
    }
}
