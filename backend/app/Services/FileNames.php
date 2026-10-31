<?php

namespace App\Services;

use App\Models\File;
use Normalizer;

/**
 * Display names for uploaded files. The client's name is only ever a label: it never
 * reaches the storage key, and it is cleaned of anything that could disguise the file.
 */
final class FileNames
{
    public const MAX_LENGTH = 120;

    /**
     * Bidi embeddings, overrides (U+202A-U+202E) and isolates (U+2066-U+2069) let
     * "exe.png" pass for "png.exe"; zero-width characters and the BOM hide in names.
     * RLM and LRM (U+200F, U+200E) are harmless marks that Hebrew names may need: kept.
     */
    private const INVISIBLE = '/[\p{Cc}\x{202A}-\x{202E}\x{2066}-\x{2069}\x{200B}-\x{200D}\x{FEFF}]/u';

    /**
     * The name to show for an upload of the detected $mime: cleaned, never empty, ending
     * with an extension of that type (appended when missing or different), at most
     * MAX_LENGTH characters with the extension preserved.
     */
    public static function forDisplay(string $clientName, string $mime): string
    {
        $extensions = File::EXTENSIONS[$mime];
        $name = self::clean($clientName);
        if ($name === '') {
            $name = 'file';
        }
        if (! in_array(self::extension($name), $extensions, true)) {
            $name .= '.'.$extensions[0];
        }

        if (mb_strlen($name) > self::MAX_LENGTH) {
            $suffix = mb_substr($name, (int) mb_strrpos($name, '.'));
            $base = rtrim(mb_substr($name, 0, self::MAX_LENGTH - mb_strlen($suffix)), '. ');
            $name = ($base === '' ? 'file' : $base).$suffix;
        }

        return $name;
    }

    /**
     * Valid UTF-8 in NFC, without control or invisible formatting characters, without any
     * path (everything up to the last / or \), whitespace collapsed, no leading or trailing
     * dots. May be empty.
     */
    public static function clean(string $name): string
    {
        $name = mb_scrub($name, 'UTF-8');
        // Whitespace first (tabs and line breaks are control characters too), then the rest.
        $name = (string) preg_replace('/[\s\p{Z}]+/u', ' ', $name);
        $name = (string) preg_replace(self::INVISIBLE, '', $name);
        $name = Normalizer::normalize($name, Normalizer::FORM_C) ?: $name;
        $name = (string) preg_replace('~^.*[/\\\\]~su', '', $name);
        $name = (string) preg_replace('/ {2,}/', ' ', $name);

        return trim($name, ' .');
    }

    /** Lower-cased text after the last dot, if any. */
    public static function extension(string $name): ?string
    {
        $dot = mb_strrpos($name, '.');
        if ($dot === false) {
            return null;
        }
        $extension = mb_strtolower(mb_substr($name, $dot + 1));

        return $extension === '' ? null : $extension;
    }
}
