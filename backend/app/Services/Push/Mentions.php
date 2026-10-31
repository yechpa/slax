<?php

namespace App\Services\Push;

/**
 * Who a message's `@name` mentions. Slax mentions are plain text (the SPA's RichText.tsx shows
 * them): `@` at the start or after a space or an opening bracket/quote, then a letter or digit
 * and up to 39 letters, digits, `_`, `.` or `-` (trailing `.`, `-`, `_` dropped). So
 * "mail@example.test" is no mention.
 *
 * A token names a person when it equals, ignoring case, their first name ("@dana" for
 * "Dana Cohen") or their whole name without spaces ("@DanaCohen"). Two people sharing a first
 * name are both notified by it.
 */
final class Mentions
{
    private const PATTERN = '/(?<=^|[\s(\[{"\'«])@([\p{L}\p{N}][\p{L}\p{N}_.\-]{0,39})/u';

    /** @return list<string> the mention tokens, lowercased, without duplicates */
    public static function tokens(string $text): array
    {
        if (! str_contains($text, '@') || ! preg_match_all(self::PATTERN, $text, $matches)) {
            return [];
        }
        $tokens = [];
        foreach ($matches[1] as $token) {
            $token = mb_strtolower(rtrim($token, '._-'));
            if ($token !== '') {
                $tokens[$token] = true;
            }
        }

        return array_keys($tokens);
    }

    /** The forms of a name a mention may use, lowercased: first name, whole name without spaces. */
    public static function handles(string $name): array
    {
        $words = preg_split('/\s+/u', trim($name), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        if ($words === []) {
            return [];
        }

        return array_values(array_unique([mb_strtolower($words[0]), mb_strtolower(implode('', $words))]));
    }

    /**
     * @param  iterable<int, string>  $names  name by user id
     * @return list<int> ids of the people the text mentions
     */
    public static function mentioned(string $text, iterable $names): array
    {
        $tokens = array_flip(self::tokens($text));
        if ($tokens === []) {
            return [];
        }
        $ids = [];
        foreach ($names as $id => $name) {
            foreach (self::handles($name) as $handle) {
                if (isset($tokens[$handle])) {
                    $ids[] = $id;
                    break;
                }
            }
        }

        return $ids;
    }
}
