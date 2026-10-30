<?php

namespace App\Http\Controllers;

use App\Models\PushSubscription;
use App\Models\User;
use App\Services\Push\Push;
use App\Services\Push\PushNotifier;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * This device's Web Push subscription (frontend/src/pwa/push.ts). With push off (no VAPID
 * keys) everything but DELETE answers 404 {"error": "push_disabled"} and the app hides the
 * setting. A device (endpoint) belongs to one account: subscribing it again, from whichever
 * account is signed in on it now, updates its keys and moves it.
 */
class PushSubscriptionController extends Controller
{
    public function publicKey(): JsonResponse
    {
        if (! Push::enabled()) {
            return self::disabled();
        }

        return response()->json(['public_key' => Push::publicKey()]);
    }

    public function store(Request $request): JsonResponse|Response
    {
        if (! Push::enabled()) {
            return self::disabled();
        }
        $data = $request->validate([
            'endpoint' => ['required', 'string', 'max:2048', 'url:https', function (string $attribute, mixed $value, Closure $fail) {
                if (! Push::allowsEndpoint((string) $value)) {
                    $fail('The endpoint must be a browser push service.');
                }
            }],
            'keys' => ['required', 'array'],
            // The browser's P-256 public key (an uncompressed point, 65 bytes) and its 16-byte secret.
            'keys.p256dh' => ['required', 'string', 'max:128', self::base64url(65, "\x04")],
            'keys.auth' => ['required', 'string', 'max:64', self::base64url(16)],
            'locale' => ['sometimes', 'string', Rule::in(User::LOCALES)],
        ]);
        $user = $request->user();

        DB::transaction(function () use ($data, $user) {
            PushSubscription::upsert([[
                'user_id' => $user->id,
                'endpoint' => $data['endpoint'],
                'p256dh' => $data['keys']['p256dh'],
                'auth' => $data['keys']['auth'],
                'locale' => $data['locale'] ?? $user->locale,
                'key_id' => Push::keyId(),
                'created_at' => now(),
            ]], ['endpoint'], ['user_id', 'p256dh', 'auth', 'locale', 'key_id']);

            // Ten devices at most: the ones that went longest without a push make room.
            $extra = PushSubscription::where('user_id', $user->id)
                ->where('endpoint', '!=', $data['endpoint'])
                ->orderByRaw('COALESCE(last_used_at, created_at) DESC, id DESC')
                ->skip(PushSubscription::MAX_PER_USER - 1)
                ->take(PHP_INT_MAX)
                ->pluck('id');
            PushSubscription::whereKey($extra)->delete();
        });

        return response()->noContent();
    }

    /** By endpoint, the caller's own device only (404 otherwise). Works with push off too. */
    public function destroy(Request $request): JsonResponse|Response
    {
        $endpoint = $request->validate(['endpoint' => ['required', 'string', 'max:2048']])['endpoint'];

        $deleted = PushSubscription::where('user_id', $request->user()->id)->where('endpoint', $endpoint)->delete();

        return $deleted > 0 ? response()->noContent() : response()->json(['error' => 'not_found'], 404);
    }

    /** A test notification to each of the caller's devices (Settings' "Send a test"). */
    public function test(Request $request, PushNotifier $notifier): JsonResponse
    {
        if (! Push::enabled()) {
            return self::disabled();
        }

        return response()->json(['devices' => $notifier->test($request->user())], 202);
    }

    private static function disabled(): JsonResponse
    {
        return response()->json(['error' => 'push_disabled'], 404);
    }

    /** base64url (no padding) decoding to exactly $bytes bytes, starting with $prefix. */
    private static function base64url(int $bytes, string $prefix = ''): Closure
    {
        return function (string $attribute, mixed $value, Closure $fail) use ($bytes, $prefix) {
            $decoded = is_string($value) && preg_match('/^[A-Za-z0-9_-]+$/', $value)
                ? base64_decode(strtr($value, '-_', '+/'), true)
                : false;
            if ($decoded === false || strlen($decoded) !== $bytes || ! str_starts_with($decoded, $prefix)) {
                $fail("The {$attribute} key is not valid.");
            }
        };
    }
}
