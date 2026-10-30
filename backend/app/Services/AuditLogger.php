<?php

namespace App\Services;

use App\Contracts\AdminNotifier;
use App\Models\AuditLog;
use Illuminate\Contracts\Redis\Factory as RedisFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

/**
 * The audit trail of sensitive actions: who (the signed-in user, if any), what (an action
 * name), on what (a type and an id, never content), from where (the request IP as Laravel
 * resolves it: behind the production proxy that needs trusted proxies, see Task 13), when.
 *
 * Moderation actions are also sent to the administrators (AdminNotifier), and so is a burst
 * of failed sign-ins from one address: `failed_sign_in_threshold` failures within a fixed
 * window of `failed_sign_in_window_minutes` raise one alert for that window.
 *
 * Recording never breaks the action it records: a failure is reported and swallowed.
 */
class AuditLogger
{
    public const SIGN_IN_FAILED = 'auth.sign_in_failed';

    public const USER_BANNED = 'user.banned';

    public const USER_UNBANNED = 'user.unbanned';

    public const MESSAGE_MODERATED_DELETE = 'message.moderated_delete';

    public const FILE_MODERATED_DELETE = 'file.moderated_delete';

    public const CHANNEL_LOCKED = 'channel.locked';

    public const CHANNEL_UNLOCKED = 'channel.unlocked';

    public const SEND_REFUSED = 'message.send_refused';

    public const DEMO_RESET = 'demo.reset';

    /** Actions the administrators hear about as they happen, with their alert level. */
    private const ALERTS = [
        self::USER_BANNED => 'warning',
        self::USER_UNBANNED => 'info',
        self::MESSAGE_MODERATED_DELETE => 'warning',
        self::FILE_MODERATED_DELETE => 'warning',
        self::CHANNEL_LOCKED => 'warning',
        self::CHANNEL_UNLOCKED => 'info',
    ];

    public function __construct(
        private readonly AdminNotifier $notifier,
        private readonly RedisFactory $redis,
    ) {}

    /**
     * A failed sign-in is `auth.sign_in_failed` or a refinement of it
     * (`auth.sign_in_failed.invalid_state`...).
     */
    public function record(string $action, ?Model $target = null): void
    {
        try {
            $entry = new AuditLog;
            $entry->forceFill([
                'actor_id' => Auth::user()?->getAuthIdentifier(),
                'action' => Str::limit($action, 64, ''),
                'target_type' => $target ? Str::snake(class_basename($target)) : null,
                'target_id' => $target?->getKey(),
                'ip' => $this->ip(),
            ])->save();
        } catch (Throwable $e) {
            report($e);

            return;
        }

        if (isset(self::ALERTS[$action])) {
            $this->notifier->notify(self::ALERTS[$action], 'Moderation: '.$action, [
                'action' => $entry->action,
                'actor_id' => $entry->actor_id,
                'target_type' => $entry->target_type,
                'target_id' => $entry->target_id,
            ]);
        }

        if (str_starts_with($action, self::SIGN_IN_FAILED) && $entry->ip !== null) {
            $this->countFailedSignIn($entry->ip);
        }
    }

    private function ip(): ?string
    {
        if (app()->runningInConsole() && ! app()->runningUnitTests()) {
            return null;
        }

        return request()->ip();
    }

    private function countFailedSignIn(string $ip): void
    {
        $threshold = max(1, (int) config('slax.alerts.failed_sign_in_threshold', 10));
        $window = max(1, (int) config('slax.alerts.failed_sign_in_window_minutes', 10)) * 60;
        $bucket = intdiv(Carbon::now()->getTimestamp(), $window);
        // The address itself is not a Redis key name anyone needs to read.
        $key = 'audit:sign-in-failures:'.hash('sha256', $ip).":{$bucket}";

        try {
            $redis = $this->redis->connection();
            $failures = (int) $redis->incr($key);
            if ($failures === 1) {
                $redis->expire($key, $window * 2);
            }
        } catch (Throwable $e) {
            Log::warning('Failed sign-in counter unavailable.', ['exception_class' => $e::class]);

            return;
        }

        // Exactly once per window and address.
        if ($failures === $threshold) {
            $this->notifier->notify('warning', 'Burst of failed sign-ins from one address', [
                'action' => self::SIGN_IN_FAILED,
                'failures' => $failures,
                'window_minutes' => intdiv($window, 60),
            ]);
        }
    }
}
