<?php

namespace App\Exceptions;

use Illuminate\Http\JsonResponse;
use RuntimeException;

/** The object store refused a write: 503, and the upload leaves nothing behind. Reported. */
class StorageUnavailable extends RuntimeException
{
    public function render(): JsonResponse
    {
        return response()->json(['error' => 'storage_unavailable'], 503);
    }
}
