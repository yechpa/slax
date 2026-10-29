<?php

namespace App\Http\Controllers;

use App\Contracts\IdentityProvider;
use App\Events\UserRegistered;
use App\Models\User;
use App\Services\Identity\GoogleProfile;
use App\Services\Identity\IdentityProviderException;
use App\Services\Turnstile;
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
    ) {}

    /** POST /api/v1/auth/google/start */
    public function start(Request $request): JsonResponse
    {
        $data = $request->validate(['turnstile_token' => ['required', 'string', 'max:4096']]);

        if (! $request->hasSession()) {
            return $this->error('session_unavailable', 400);
        }
        if (! $this->turnstile->verify($data['turnstile_token'], (string) $request->ip())) {
            return $this->error('turnstile_failed', 422);
        }

        $state = Str::random(40);
        $nonce = Str::random(40);
        $request->session()->put(self::SESSION_KEY, ['state' => $state, 'nonce' => $nonce]);

        return response()->json(['redirect_url' => $this->google->authorizationUrl($state, $nonce)]);
    }

    /** GET /auth/google/callback?code&state (the browser comes back from Google) */
    public function callback(Request $request): RedirectResponse|JsonResponse
    {
        // Single use, whatever the outcome.
        $expected = $request->session()->pull(self::SESSION_KEY);
        $state = $request->query('state');
        $code = $request->query('code');

        if (! is_array($expected) || ! is_string($state) || ! hash_equals((string) ($expected['state'] ?? ''), $state)) {
            return $this->error('invalid_state', 422);
        }
        if (! is_string($code) || $code === '') {
            return $this->error('invalid_code', 422);
        }

        try {
            $profile = $this->google->exchange($code, (string) $expected['nonce']);
        } catch (IdentityProviderException) {
            return $this->error('invalid_token', 422);
        }

        if (! $profile->emailVerified) {
            return $this->error('email_not_verified', 403);
        }

        [$user, $created] = $this->findOrCreateUser($profile);

        if ($user->isBanned()) {
            return $this->error('account_banned', 403);
        }

        Auth::guard('web')->login($user);
        $request->session()->regenerate();

        if ($created) {
            UserRegistered::dispatch($user);
        }

        return redirect('/');
    }

    /** POST /api/v1/auth/logout */
    public function logout(Request $request): Response
    {
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->noContent();
    }

    /**
     * Identity is the Google subject. Name, avatar and e-mail follow Google;
     * administrators are exactly the addresses listed in ADMIN_EMAILS.
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
            $user->save();
        }

        return [$user, $created];
    }

    private function error(string $code, int $status): JsonResponse
    {
        return response()->json(['error' => $code], $status);
    }
}
