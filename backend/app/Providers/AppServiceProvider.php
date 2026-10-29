<?php

namespace App\Providers;

use App\Contracts\IdentityProvider;
use App\Services\FakeTurnstile;
use App\Services\Identity\FakeIdentityProvider;
use App\Services\Identity\GoogleIdentityProvider;
use App\Services\Turnstile;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Google and Cloudflare are never called from automated tests or E2E runs.
        $faked = $this->app->environment(['testing', 'e2e']);

        $this->app->singleton(IdentityProvider::class, $faked ? FakeIdentityProvider::class : GoogleIdentityProvider::class);
        $this->app->singleton(Turnstile::class, $faked ? FakeTurnstile::class : Turnstile::class);
    }

    public function boot(): void
    {
        RateLimiter::for('auth-start', fn (Request $request) => Limit::perMinute(10)->by($request->ip()));
        RateLimiter::for('auth-callback', fn (Request $request) => Limit::perMinute(20)->by($request->ip()));
    }
}
