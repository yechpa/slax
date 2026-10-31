<?php

namespace App\Exceptions;

use Illuminate\Http\JsonResponse;
use RuntimeException;

/**
 * The scanner could not give a usable verdict (down, timeout, error status, malformed
 * answer). Uploads fail closed: 503 and nothing stored. Reported, so outages are noticed.
 */
class ScannerUnavailable extends RuntimeException
{
    public function render(): JsonResponse
    {
        return response()->json(['error' => 'scanner_unavailable'], 503);
    }
}
