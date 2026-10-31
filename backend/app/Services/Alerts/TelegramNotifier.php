<?php

namespace App\Services\Alerts;

use App\Contracts\AdminNotifier;
use Illuminate\Contracts\Redis\Factory as RedisFactory;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

use function Illuminate\Support\defer;

/**
 * Alerts through the Telegram Bot API (`sendMessage`, plain text).
 *
 *  - Every message starts with the environment label, `[Dev]` unless SLAX_ENV_LABEL says
 *    otherwise (production opts in with `Prod`).
 *  - Context is sanitised by AlertContext (allowlist; no bodies, names or addresses).
 *  - Alerts are grouped by what failed and where: level, title, and the context's exception
 *    class, location, route, method and log channel (not ids, counts or the message digest, which still
 *    show in the text). One per group goes out per 5 minutes; the duplicates held back are
 *    counted and reported as "×N" with the next one.
 *  - Grouping lives in Redis. Redis unavailable (and then left alone for 30 s by this
 *    process, a circuit breaker): the same grouping on the local file cache, and at most
 *    about FALLBACK_PER_MINUTE alerts a minute in all (critical ones excepted), so an outage
 *    cannot turn every failing request into a post. Neither available: the alert is dropped (logged locally).
 *  - Sending never throws and never holds a request: during HTTP requests it runs after the
 *    response is sent (deferred), elsewhere (commands, workers) inline, with short timeouts.
 *    A failure is logged locally at `warning`, below what the `telegram` log channel relays,
 *    and without the exception message (Guzzle puts the URL, hence the token, in it).
 */
class TelegramNotifier implements AdminNotifier
{
    public const API = 'https://api.telegram.org';

    public const DEDUPE_SECONDS = 300;

    public const TIMEOUT_SECONDS = 3;

    /** Alerts a minute while Redis is unavailable, whatever they are. */
    public const FALLBACK_PER_MINUTE = 5;

    /** How long this process stops asking an unavailable Redis. */
    public const REDIS_RETRY_SECONDS = 30;

    /** Context keys that tell one problem from another (see the class comment). */
    private const GROUP_KEYS = ['exception', 'location', 'route', 'method', 'log_channel'];

    /** Until when (microtime) this process skips Redis. */
    private static float $redisDownUntil = 0.0;

    /** Telegram refuses longer messages. */
    public const MAX_TEXT = 4000;

    private const ICONS = ['info' => 'ℹ️', 'warning' => '⚠️', 'error' => '❌', 'critical' => '🚨'];

    public function __construct(
        private readonly string $token,
        private readonly string $chatId,
        private readonly RedisFactory $redis,
    ) {}

    public function notify(string $level, string $title, array $context = []): void
    {
        AlertContext::assertLevel($level);

        try {
            $title = AlertContext::title($title);
            $context = AlertContext::sanitize($context);

            $group = array_intersect_key($context, array_flip(self::GROUP_KEYS));
            ksort($group);
            $heldBack = $this->claim(hash('sha256', json_encode([$level, $title, $group], JSON_THROW_ON_ERROR)), $level);
            if ($heldBack === null) {
                return;
            }

            $text = $this->format($level, $title, $context, $heldBack);
        } catch (Throwable $e) {
            Log::warning('Admin alert could not be prepared.', ['exception_class' => $e::class]);

            return;
        }

        if (app()->runningInConsole()) {
            $this->send($text);
        } else {
            defer(fn () => $this->send($text), always: true);
        }
    }

    /** Tests: forget that Redis was found unavailable. */
    public static function resetCircuitBreaker(): void
    {
        self::$redisDownUntil = 0.0;
    }

    /**
     * Null when the same alert went out less than 5 minutes ago (it is counted instead), or
     * when it must be held back; otherwise the number of duplicates held back since the last
     * one sent. Times are compared on the application clock as well as by TTL.
     */
    private function claim(string $hash, string $level): ?int
    {
        $now = Carbon::now()->getTimestamp();

        if (microtime(true) >= self::$redisDownUntil) {
            try {
                return $this->claimInRedis($hash, $now);
            } catch (Throwable $e) {
                self::$redisDownUntil = microtime(true) + self::REDIS_RETRY_SECONDS;
                Log::warning('Admin alert grouping: Redis unavailable, using the local fallback.', ['exception_class' => $e::class]);
            }
        }

        return $this->claimWithoutRedis($hash, $now, $level);
    }

    private function claimInRedis(string $hash, int $now): ?int
    {
        $sentKey = "alerts:sent:{$hash}";
        $heldKey = "alerts:held:{$hash}";
        $redis = $this->redis->connection();

        $last = $redis->get($sentKey);
        if ($last !== null && $last !== false && $now - (int) $last < self::DEDUPE_SECONDS) {
            $redis->incr($heldKey);
            $redis->expire($heldKey, 86400);

            return null;
        }

        $redis->setex($sentKey, self::DEDUPE_SECONDS, $now);
        $held = (int) $redis->get($heldKey);
        $redis->del($heldKey);

        return $held;
    }

    /**
     * The same grouping on the file cache (shared by the processes of one host), with a cap.
     * An alert the cap holds back is not marked as sent, so it goes out once the minute is
     * over; critical ones are never capped. The file cache has no atomic add or increment
     * across processes, so the cap is approximate: a few more may pass under contention.
     */
    private function claimWithoutRedis(string $hash, int $now, string $level): ?int
    {
        try {
            $store = Cache::store('file');
            $sentKey = "alerts:sent:{$hash}";
            $heldKey = "alerts:held:{$hash}";

            if ($store->has($sentKey)) {
                $store->add($heldKey, 0, 86400);
                $store->increment($heldKey);

                return null;
            }

            if ($level !== 'critical') {
                $minute = 'alerts:fallback:'.intdiv($now, 60);
                $store->add($minute, 0, 120);
                if ((int) $store->increment($minute) > self::FALLBACK_PER_MINUTE) {
                    return null;
                }
            }

            if (! $store->add($sentKey, $now, self::DEDUPE_SECONDS)) {
                // Another process sent it in the meantime.
                $store->add($heldKey, 0, 86400);
                $store->increment($heldKey);

                return null;
            }

            return (int) $store->pull($heldKey, 0);
        } catch (Throwable $e) {
            Log::warning('Admin alert dropped: no way to group it.', ['exception_class' => $e::class]);

            return null;
        }
    }

    /** @param array<string, scalar|null> $context */
    private function format(string $level, string $title, array $context, int $heldBack): string
    {
        $label = preg_replace('/[^A-Za-z0-9 _-]/', '', (string) config('slax.alerts.env_label', 'Dev'));
        $label = trim(substr((string) $label, 0, 12)) ?: 'Dev';

        $lines = ['['.$label.'] '.self::ICONS[$level].' '.strtoupper($level).' · '.$title];
        foreach ($context as $key => $value) {
            $lines[] = $key.': '.match (true) {
                is_bool($value) => $value ? 'true' : 'false',
                $value === null => 'null',
                default => (string) $value,
            };
        }
        if ($heldBack > 0) {
            $lines[] = "×{$heldBack} similar alert(s) held back since the last one";
        }

        return mb_substr(implode("\n", $lines), 0, self::MAX_TEXT);
    }

    private function send(string $text): void
    {
        try {
            $response = Http::connectTimeout(2)
                ->timeout(self::TIMEOUT_SECONDS)
                ->asJson()
                ->post(self::API."/bot{$this->token}/sendMessage", [
                    'chat_id' => $this->chatId,
                    'text' => $text,
                    'disable_web_page_preview' => true,
                ]);

            if (! $response->successful()) {
                Log::warning('Admin alert refused by Telegram.', ['status' => $response->status()]);
            }
        } catch (Throwable $e) {
            Log::warning('Admin alert could not be sent to Telegram.', ['exception_class' => $e::class]);
        }
    }
}
