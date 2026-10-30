<?php

namespace App\Providers;

use App\Broadcasting\ReverbBroadcaster;
use App\Contracts\IdentityProvider;
use App\Http\Controllers\GoogleAuthController;
use App\Services\FakeScannerClient;
use App\Services\FakeTurnstile;
use App\Services\Identity\FakeIdentityProvider;
use App\Services\Identity\GoogleIdentityProvider;
use App\Services\ScannerClient;
use App\Services\Turnstile;
use Illuminate\Broadcasting\BroadcastManager;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Google and Cloudflare are never called from automated tests or E2E runs.
        $faked = $this->app->environment(['testing', 'e2e']);

        $this->app->singleton(IdentityProvider::class, $faked ? FakeIdentityProvider::class : GoogleIdentityProvider::class);
        $this->app->singleton(Turnstile::class, $faked ? FakeTurnstile::class : Turnstile::class);
        // The scanner runs in the compose stack, E2E runs included: only unit and feature tests fake it.
        $this->app->singleton(ScannerClient::class, $this->app->environment('testing') ? FakeScannerClient::class : ScannerClient::class);
    }

    public function boot(): void
    {
        // The API returns bare resources and arrays, not {"data": ...} envelopes.
        JsonResource::withoutWrapping();

        RateLimiter::for('auth-start', fn (Request $request) => Limit::perMinute(10)->by($request->ip()));
        // The callback is a browser navigation: a refusal goes back to the SPA, which explains it.
        RateLimiter::for('auth-callback', fn (Request $request) => Limit::perMinute(20)->by($request->ip())
            ->response(fn () => GoogleAuthController::failed('rate_limited')));
        RateLimiter::for('dms', fn (Request $request) => Limit::perMinute(20)->by('user:'.$request->user()->id));
        // One tab pings 2.4 times a minute; this leaves room for about eight.
        RateLimiter::for('presence-heartbeat', fn (Request $request) => Limit::perMinute(20)->by('user:'.$request->user()->id));
        RateLimiter::for('messages', fn (Request $request) => Limit::perMinute(30)->by('user:'.$request->user()->id));
        RateLimiter::for('uploads', fn (Request $request) => Limit::perMinute(20)->by('user:'.$request->user()->id));

        // Ids are bigints: anything else is a 404, not a database error.
        Route::pattern('channel', '[0-9]+');
        Route::pattern('message', '[0-9]+');
        Route::pattern('file', '[0-9]+');

        // Reverb speaks the Pusher protocol; this subclass adds what channel revocation needs.
        Broadcast::extend('reverb', fn ($app, array $config) => new ReverbBroadcaster($app->make(BroadcastManager::class)->pusher($config)));
    }
}
