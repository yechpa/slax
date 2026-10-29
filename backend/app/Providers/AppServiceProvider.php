<?php

namespace App\Providers;

use App\Contracts\IdentityProvider;
use App\Services\FakeTurnstile;
use App\Services\Identity\FakeIdentityProvider;
use App\Services\Identity\GoogleIdentityProvider;
use App\Services\Turnstile;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
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
    }

    public function boot(): void
    {
        // The API returns bare resources and arrays, not {"data": ...} envelopes.
        JsonResource::withoutWrapping();

        RateLimiter::for('auth-start', fn (Request $request) => Limit::perMinute(10)->by($request->ip()));
        RateLimiter::for('auth-callback', fn (Request $request) => Limit::perMinute(20)->by($request->ip()));
        RateLimiter::for('messages', fn (Request $request) => Limit::perMinute(30)->by('user:'.$request->user()->id));

        // Ids are bigints: anything else is a 404, not a database error.
        Route::pattern('channel', '[0-9]+');
        Route::pattern('message', '[0-9]+');
    }
}
