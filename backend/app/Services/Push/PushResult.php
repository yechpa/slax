<?php

namespace App\Services\Push;

/** What a push service answered (the reason is for the logs; it never holds the payload). */
final readonly class PushResult
{
    public function __construct(
        public PushOutcome $outcome,
        public ?int $status = null,
        public string $reason = '',
    ) {}

    public static function delivered(?int $status = 201): self
    {
        return new self(PushOutcome::Delivered, $status);
    }

    public static function gone(int $status = 410): self
    {
        return new self(PushOutcome::Gone, $status);
    }

    public static function retry(?int $status, string $reason): self
    {
        return new self(PushOutcome::Retry, $status, $reason);
    }

    public static function rejected(?int $status, string $reason): self
    {
        return new self(PushOutcome::Rejected, $status, $reason);
    }

    /** From an HTTP status (null: no answer at all). */
    public static function fromStatus(?int $status, string $reason = ''): self
    {
        return match (true) {
            $status !== null && $status >= 200 && $status < 300 => self::delivered($status),
            $status === 404, $status === 410 => self::gone($status),
            $status === null, $status === 429, $status >= 500 => self::retry($status, $reason),
            default => self::rejected($status, $reason),
        };
    }
}
