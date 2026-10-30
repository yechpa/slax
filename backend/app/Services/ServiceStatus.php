<?php

namespace App\Services;

use Aws\S3\S3Client;
use Closure;
use Illuminate\Filesystem\AwsS3V3Adapter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * Health of what Slax depends on, for the administrators' status page: each service is `ok`
 * or `degraded`, with the time its probe took. Probes have short timeouts and never throw;
 * the answer carries no host names, credentials or error messages.
 */
class ServiceStatus
{
    public const TIMEOUT_SECONDS = 2;

    /** @return list<array{name: string, status: 'ok'|'degraded', latency_ms: int}> */
    public function check(): array
    {
        return [
            $this->probe('database', fn () => DB::select('select 1') !== []),
            $this->probe('redis', fn () => (bool) Redis::connection()->ping()),
            $this->probe('reverb', fn () => Http::connectTimeout(self::TIMEOUT_SECONDS)->timeout(self::TIMEOUT_SECONDS)
                ->get($this->reverbUrl().'/up')->successful()),
            $this->probe('scanner', fn () => Http::connectTimeout(self::TIMEOUT_SECONDS)->timeout(self::TIMEOUT_SECONDS)
                ->get(rtrim((string) config('services.scanner.url'), '/').'/health')->successful()),
            $this->probe('s3', fn () => $this->objectStorageReachable()),
        ];
    }

    /** @return array{name: string, status: 'ok'|'degraded', latency_ms: int} */
    private function probe(string $name, Closure $check): array
    {
        $started = hrtime(true);
        try {
            $ok = (bool) $check();
        } catch (Throwable) {
            $ok = false;
        }

        return [
            'name' => $name,
            'status' => $ok ? 'ok' : 'degraded',
            'latency_ms' => (int) round((hrtime(true) - $started) / 1e6),
        ];
    }

    /** Where the application publishes to Reverb (its HTTP API serves GET /up). */
    private function reverbUrl(): string
    {
        $options = (array) config('broadcasting.connections.reverb.options', []);
        $scheme = (string) ($options['scheme'] ?? 'http');
        $host = (string) ($options['host'] ?? 'localhost');
        $port = (int) ($options['port'] ?? 8080);

        return "{$scheme}://{$host}:{$port}";
    }

    /** HEAD on the bucket (S3); for another disk (tests), a plain existence check. */
    private function objectStorageReachable(): bool
    {
        $disk = Storage::disk(FileUploads::DISK);

        if ($disk instanceof AwsS3V3Adapter) {
            $client = $disk->getClient();
            assert($client instanceof S3Client);
            $client->headBucket([
                'Bucket' => (string) $disk->getConfig()['bucket'],
                '@http' => ['timeout' => self::TIMEOUT_SECONDS, 'connect_timeout' => self::TIMEOUT_SECONDS],
            ]);

            return true;
        }

        $disk->exists('.slax-health');

        return true;
    }
}
