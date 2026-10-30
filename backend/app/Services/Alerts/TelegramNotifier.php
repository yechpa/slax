<?php

namespace App\Services\Alerts;

use App\Contracts\AdminNotifier;
use Illuminate\Contracts\Redis\Factory as RedisFactory;
use Illuminate\Support\Carbon;
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
 *  - Identical alerts (same level, title and context) are sent once per 5 minutes; the
 *    duplicates held back are counted in Redis and reported as "×N" with the next one.
 *    Redis unavailable: the alert is sent anyway.
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

            $heldBack = $this->claim(hash('sha256', json_encode([$level, $title, $context], JSON_THROW_ON_ERROR)));
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

    /**
     * Null when the same alert went out less than 5 minutes ago (it is counted instead);
     * otherwise the number of duplicates held back since the last one sent.
     * Times are compared on the application clock as well as by TTL.
     */
    private function claim(string $hash): ?int
    {
        $sentKey = "alerts:sent:{$hash}";
        $heldKey = "alerts:held:{$hash}";

        try {
            $redis = $this->redis->connection();
            $now = Carbon::now()->getTimestamp();

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
        } catch (Throwable $e) {
            Log::warning('Admin alert deduplication unavailable; sending anyway.', ['exception_class' => $e::class]);

            return 0;
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
            $lines[] = "×{$heldBack} identical alert(s) held back since the last one";
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
