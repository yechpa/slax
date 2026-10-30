<?php

namespace App\Services;

/** The scanner's verdict on one file. */
final readonly class ScanResult
{
    public function __construct(
        public bool $ok,
        /** Stable code when refused (e.g. `type_not_allowed`), null when accepted. */
        public ?string $reason,
        public string $sha256,
        public string $detectedMime,
    ) {}

    /**
     * The verdict in a `POST /scan` answer, or null when it is not one: a missing or
     * mistyped field, an accepted file without a SHA-256 or type, a refusal without a
     * well-formed reason code.
     */
    public static function fromPayload(mixed $data): ?self
    {
        if (! is_array($data)
            || ! is_bool($data['ok'] ?? null)
            || ! array_key_exists('reason', $data)
            || ! (is_string($data['reason']) || $data['reason'] === null)
            || ! is_string($data['sha256'] ?? null)
            || ! is_string($data['detected_mime'] ?? null)) {
            return null;
        }

        if ($data['ok']) {
            if (! preg_match('/^[0-9a-f]{64}$/D', $data['sha256']) || $data['detected_mime'] === '') {
                return null;
            }
        } elseif (! preg_match('/^[a-z0-9_]{1,64}$/D', (string) $data['reason'])) {
            return null;
        }

        return new self($data['ok'], $data['ok'] ? null : $data['reason'], $data['sha256'], $data['detected_mime']);
    }
}
