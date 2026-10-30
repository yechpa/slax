<?php

namespace App\Exceptions;

use Illuminate\Http\JsonResponse;
use RuntimeException;

/**
 * An upload refused for what it is (size, type, content, quota): 422 with a stable reason
 * code, e.g. `empty_file`, `too_large`, `quota_exceeded`, or one of the scanner's.
 */
class FileRejected extends RuntimeException
{
    public function __construct(public readonly string $reason)
    {
        parent::__construct("File rejected: {$reason}");
    }

    public function render(): JsonResponse
    {
        return response()->json(['error' => 'file_rejected', 'reason' => $this->reason], 422);
    }

    /** An expected outcome, not an error worth logging. */
    public function report(): void {}
}
