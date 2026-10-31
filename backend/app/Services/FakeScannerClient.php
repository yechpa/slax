<?php

namespace App\Services;

use App\Exceptions\ScannerUnavailable;
use Closure;
use finfo;
use Illuminate\Http\UploadedFile;

/**
 * Bound only when APP_ENV is `testing`: accepts everything, with the type PHP's fileinfo
 * detects, unless a test makes it unavailable, refuse, or report another type.
 */
class FakeScannerClient extends ScannerClient
{
    public bool $down = false;

    public ?string $rejectWith = null;

    public ?string $mime = null;

    /** Runs during the scan, e.g. to let a concurrent request commit meanwhile. */
    public ?Closure $whileScanning = null;

    public int $calls = 0;

    public function scan(UploadedFile $file): ScanResult
    {
        $this->calls++;
        if ($this->whileScanning !== null) {
            ($this->whileScanning)();
        }
        if ($this->down) {
            throw new ScannerUnavailable('The scanner is down (fake).');
        }

        $path = (string) $file->getRealPath();

        return new ScanResult(
            ok: $this->rejectWith === null,
            reason: $this->rejectWith,
            sha256: hash_file('sha256', $path),
            detectedMime: $this->mime ?? (string) (new finfo(FILEINFO_MIME_TYPE))->file($path),
        );
    }
}
