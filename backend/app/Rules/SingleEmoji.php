<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/** One emoji (a single grapheme: plain, keycap, flag, skin tone or ZWJ sequence), 16 bytes at most. */
class SingleEmoji implements ValidationRule
{
    public const MAX_BYTES = 16;

    private const PATTERN = '/^(?:
        [#*0-9]\x{FE0F}?\x{20E3}
        | [\x{1F1E6}-\x{1F1FF}]{2}
        | \p{Extended_Pictographic}[\x{FE0E}\x{FE0F}]?[\x{1F3FB}-\x{1F3FF}]?
          (?:\x{200D}\p{Extended_Pictographic}[\x{FE0E}\x{FE0F}]?[\x{1F3FB}-\x{1F3FF}]?)*
    )$/ux';

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! is_string($value)
            || strlen($value) > self::MAX_BYTES
            || ! mb_check_encoding($value, 'UTF-8')
            || grapheme_strlen($value) !== 1
            || preg_match(self::PATTERN, $value) !== 1) {
            $fail('The :attribute must be a single emoji.');
        }
    }
}
