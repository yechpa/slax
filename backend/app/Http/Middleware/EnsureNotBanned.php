<?php

namespace App\Http\Middleware;

use App\Services\UserSessions;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/**
 * Runs after authentication: a banned user loses the session they already hold, and a session
 * that was signed out (UserSessions::end) stays signed out even if a request that was in flight
 * during the sign-out wrote it back.
 */
class EnsureNotBanned
{
    public function __construct(private readonly UserSessions $sessions) {}

    public function handle(Request $request, Closure $next): Response
    {
        if ($request->user() !== null && $request->hasSession() && $this->sessions->ended($request->session()->getId())) {
            Auth::guard('web')->logout();
            $request->session()->invalidate();

            return response()->json(['message' => 'Unauthenticated.'], 401);
        }

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
