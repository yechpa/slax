<?php

use App\Http\Middleware\EnsureNotBanned;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    // POST /broadcasting/auth on the SPA session; banned users are refused there too.
    ->withBroadcasting(__DIR__.'/../routes/channels.php', ['middleware' => ['web', 'not-banned']])
    ->withMiddleware(function (Middleware $middleware): void {
        // API routes share the SPA's session cookie (Sanctum "stateful" requests).
        $middleware->statefulApi();
        $middleware->alias(['not-banned' => EnsureNotBanned::class]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        //
    })->create();
