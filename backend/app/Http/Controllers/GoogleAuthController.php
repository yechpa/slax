<?php

namespace App\Http\Controllers;

use App\Contracts\IdentityProvider;
use App\Events\UserRegistered;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\Identity\GoogleProfile;
use App\Services\Identity\IdentityProviderException;
use App\Services\Turnstile;
use App\Services\UserSessions;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Str;

class GoogleAuthController extends Controller
{
    private const SESSION_KEY = 'google_oauth';

    public function __construct(
        private readonly IdentityProvider $google,
        private readonly Turnstile $turnstile,
        private readonly AuditLogger $audit,
        private readonly UserSessions $sessions,
    ) {}

    /** POST /api/v1/auth/google/start */
    public function start(Request $request): JsonResponse
    {
        $data = $request->validate(['turnstile_token' => ['required', 'string', 'max:4096']]);

        if (! $request->hasSession()) {
            return $this->error('session_unavailable', 400);
        }
        if (! $this->turnstile->verify($data['turnstile_token'], (string) $request->ip())) {
            $this->audit->record(AuditLogger::SIGN_IN_FAILED.'.turnstile');

            return $this->error('turnstile_failed', 422);
        }

        $state = Str::random(40);
        $nonce = Str::random(40);
        $request->session()->put(self::SESSION_KEY, ['state' => $state, 'nonce' => $nonce]);

        return response()->json(['redirect_url' => $this->google->authorizationUrl($state, $nonce)]);
    }

    /**
     * GET /auth/google/callback?code&state (the browser comes back from Google).
     *
     * This is a browser navigation, so every failure redirects to the SPA with a stable
     * code (`/?auth_error=…`) that it translates, instead of showing a raw error page.
     */
    public function callback(Request $request): RedirectResponse
    {
        // Single use, whatever the outcome.
        $expected = $request->session()->pull(self::SESSION_KEY);
        $state = $request->query('state');
        $code = $request->query('code');

        if (! is_array($expected) || ! is_string($state) || ! hash_equals((string) ($expected['state'] ?? ''), $state)) {
            return $this->refuse('invalid_state');
        }
        // Google answers ?error=access_denied (and no code) when the user declines.
        if (! is_string($code) || $code === '') {
            return $this->refuse('provider_error');
        }

        try {
            $profile = $this->google->exchange($code, (string) $expected['nonce']);
        } catch (IdentityProviderException) {
            return $this->refuse('invalid_token');
        }

        if (! $profile->emailVerified) {
            return $this->refuse('email_unverified');
        }

        // Before anything is written: a banned account's profile is not refreshed either.
        $banned = User::where('google_sub', $profile->sub)->whereNotNull('banned_at')->first();
        if ($banned !== null) {
            return $this->refuse('banned', $banned);
        }

        [$user, $created] = $this->findOrCreateUser($profile);

        if ($user->isBanned()) {
            return $this->refuse('banned', $user);
        }

        Auth::guard('web')->login($user);
        $request->session()->regenerate();
        $this->sessions->remember($user, $request->session()->getId());
        $user->touchLastSeen();

        if ($created) {
            UserRegistered::dispatch($user);
        }

        return redirect('/');
    }

    /** POST /api/v1/auth/logout */
    public function logout(Request $request): Response
    {
        $this->sessions->forget($request->user(), $request->session()->getId());
        $this->sessions->end($request->session()->getId());
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->noContent();
    }

    /**
     * Identity is the Google subject. Name, avatar and e-mail follow Google;
     * administrators are exactly the addresses listed in ADMIN_EMAILS.
     * Everybody else who signs up is a visitor of the public demo (a `demo` account, deleted
     * after a week without activity); an administrator's account is never a demo one.
     *
     * @return array{0: User, 1: bool} the user and whether it was just created
     */
    private function findOrCreateUser(GoogleProfile $profile): array
    {
        $email = Str::lower(trim($profile->email));
        $attributes = [
            'email' => $email,
            'name' => $profile->name,
            'avatar_url' => $profile->avatar,
        ];
        $isAdmin = in_array($email, config('slax.admin_emails'), true);

        $user = User::firstWhere('google_sub', $profile->sub);
        $created = $user === null;

        if ($created) {
            $user = new User($attributes);
            $user->google_sub = $profile->sub;
            $user->is_admin = $isAdmin;
            $user->account_type = $isAdmin ? User::ACCOUNT_MEMBER : User::ACCOUNT_DEMO;
            try {
                $user->save();
            } catch (UniqueConstraintViolationException) {
                // A concurrent first login for the same account won the race.
                $user = User::where('google_sub', $profile->sub)->firstOrFail();
                $created = false;
            }
        }

        if (! $created) {
            $user->fill($attributes);
            $user->is_admin = $isAdmin;
            if ($isAdmin) {
                $user->account_type = User::ACCOUNT_MEMBER;
            }
            $user->save();
        }

        return [$user, $created];
    }

    /** A failed sign-in: audited (and counted per address), then back to the SPA. */
    private function refuse(string $code, ?User $user = null): RedirectResponse
    {
        $this->audit->record(AuditLogger::SIGN_IN_FAILED.'.'.$code, $user);

        return self::failed($code);
    }

    private function error(string $code, int $status): JsonResponse
    {
        return response()->json(['error' => $code], $status);
    }

    /**
     * Back to the SPA's sign-in screen with one of: invalid_state, provider_error,
     * invalid_token, email_unverified, banned (and rate_limited, see AppServiceProvider).
     */
    public static function failed(string $code): RedirectResponse
    {
        return redirect('/?'.http_build_query(['auth_error' => $code]));
    }
}
