<?php

namespace App\Services;

use App\Exceptions\ScannerUnavailable;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * Client of the upload scanner (services/scanner). Any failure to get a well-formed
 * verdict — connection error, timeout, non-2xx status, malformed answer — raises
 * ScannerUnavailable, so callers fail closed.
 */
class ScannerClient
{
    public const TIMEOUT_SECONDS = 5;

    public function __construct(private readonly ?string $baseUrl = null) {}

    public function scan(UploadedFile $file): ScanResult
    {
        $stream = @fopen((string) $file->getRealPath(), 'rb');
        if ($stream === false) {
            throw new ScannerUnavailable('The upload could not be read for scanning.');
        }

        try {
            $response = Http::timeout(self::TIMEOUT_SECONDS)
                ->connectTimeout(2)
                ->withoutRedirecting()
                ->acceptJson()
                ->attach('file', $stream, self::nameForScan($file))
                ->post($this->url());
        } catch (Throwable $e) {
            throw new ScannerUnavailable('The scanner could not be reached: '.$e->getMessage(), previous: $e);
        } finally {
            if (is_resource($stream)) {
                fclose($stream);
            }
        }

        if (! $response->successful()) {
            throw new ScannerUnavailable("The scanner answered HTTP {$response->status()}.");
        }

        return ScanResult::fromPayload($response->json())
            ?? throw new ScannerUnavailable('The scanner gave a malformed answer.');
    }

    private function url(): string
    {
        return rtrim($this->baseUrl ?? (string) config('services.scanner.url'), '/').'/scan';
    }

    /**
     * The scanner checks the extension against the content, and only needs that: the
     * client's name itself (quotes, line breaks...) never goes into the request.
     */
    private static function nameForScan(UploadedFile $file): string
    {
        $extension = FileNames::extension(FileNames::clean($file->getClientOriginalName()));

        return $extension !== null && preg_match('/^[a-z0-9]{1,16}$/D', $extension) ? "upload.{$extension}" : 'upload';
    }
}
