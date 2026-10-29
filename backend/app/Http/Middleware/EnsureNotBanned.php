<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/**
 * Runs after authentication: a banned user loses the session they already hold.
 */
class EnsureNotBanned
{
    public function handle(Request $request, Closure $next): Response
    {
        if ($request->user()?->isBanned()) {
            Auth::guard('web')->logout();
            if ($request->hasSession()) {
                $request->session()->invalidate();
            }

            return response()->json(['error' => 'account_banned'], 403);
        }

        return $next($request);
    }
}
