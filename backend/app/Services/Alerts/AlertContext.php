<?php

namespace App\Services\Alerts;

use App\Contracts\AdminNotifier;
use InvalidArgumentException;

/**
 * What an alert may carry. Context is an allowlist of keys holding identifiers, counts,
 * statuses and code locations; values are scalars, cut short, with anything shaped like
 * an e-mail address redacted. Everything else (bodies, names, addresses, nested data)
 * is dropped before it can leave the application.
 */
final class AlertContext
{
    public const ALLOWED_KEYS = [
        'action', 'actor_id', 'target_type', 'target_id',
        'user_id', 'channel_id', 'message_id', 'file_id',
        'count', 'failures', 'threshold', 'window_minutes',
        'status', 'status_code', 'service', 'latency_ms',
        'route', 'method', 'exception', 'location', 'digest', 'log_channel',
        'job', 'queue', 'attempts', 'duration_ms',
        'deleted_users', 'deleted_messages', 'deleted_channels', 'deleted_files', 'failed_files', 'kept_users',
        'age_hours', 'newest',
    ];

    public const MAX_VALUE_LENGTH = 120;

    public const MAX_TITLE_LENGTH = 200;

    public static function assertLevel(string $level): void
    {
        if (! in_array($level, AdminNotifier::LEVELS, true)) {
            throw new InvalidArgumentException("Unknown alert level [{$level}].");
        }
    }

    /**
     * @param  array<array-key, mixed>  $context
     * @return array<string, scalar|null>
     */
    public static function sanitize(array $context): array
    {
        $clean = [];
        foreach (self::ALLOWED_KEYS as $key) {
            if (! array_key_exists($key, $context)) {
                continue;
            }
            $value = $context[$key];
            if (is_string($value)) {
                $clean[$key] = self::text($value, self::MAX_VALUE_LENGTH);
            } elseif (is_int($value) || is_float($value) || is_bool($value) || $value === null) {
                $clean[$key] = $value;
            }
        }

        return $clean;
    }

    public static function title(string $title): string
    {
        return self::text($title, self::MAX_TITLE_LENGTH);
    }

    /** One line, no control characters, no e-mail address, at most $max characters. */
    private static function text(string $value, int $max): string
    {
        $value = (string) preg_replace('/[^\s@<>()"\'`,;:]+@[^\s@<>()"\'`,;:]+/u', '[email]', $value);
        $value = (string) preg_replace('/[\p{Cc}\p{Cf}]+/u', ' ', $value);
        $value = trim($value);

        return mb_strlen($value) > $max ? mb_substr($value, 0, $max - 1).'…' : $value;
    }
}
