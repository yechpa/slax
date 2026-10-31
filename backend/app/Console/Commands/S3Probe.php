<?php

namespace App\Console\Commands;

use App\Services\FileUploads;
use App\Support\AwsErrors;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Throwable;

/**
 * Proves the files bucket works with this environment's credentials, exactly as uploads use
 * it: put (through Flysystem, so with the same x-amz-acl: private header and content type),
 * get, delete of a small object under files/. Errors are thrown (the disk's `throw` is
 * forced on: with the default `throw => false` a refused put only returns false) and printed
 * as the AWS error code and the exception class. Production's pre-release check
 * (docs/runbook.md §7) runs it in a one-off pod before any release exists.
 */
class S3Probe extends Command
{
    protected $signature = 'slax:s3-probe';

    protected $description = 'Put, get and delete a small object in the files bucket; PASS or FAIL with the AWS error code';

    public function handle(): int
    {
        $name = FileUploads::DISK;
        // Set before the disk is first resolved in this process (an artisan run starts fresh).
        config(["filesystems.disks.{$name}.throw" => true]);
        $disk = Storage::disk($name);
        $bucket = (string) config("filesystems.disks.{$name}.bucket");
        $key = 'files/probe/slax-s3-probe-'.Str::uuid()->toString().'.txt';
        $body = 'slax s3 probe '.now()->toIso8601String();

        $step = 'put';
        try {
            if (! $disk->put($key, $body, ['ContentType' => 'text/plain'])) {
                return $this->fail_($step, $bucket, 'the write was refused (no error detail)');
            }
            $step = 'get';
            if ($disk->get($key) !== $body) {
                return $this->fail_($step, $bucket, 'the object read back differs');
            }
            $step = 'delete';
            if (! $disk->delete($key)) {
                return $this->fail_($step, $bucket, 'the delete was refused (no error detail)');
            }
        } catch (Throwable $e) {
            $code = AwsErrors::code($e) ?? 'no AWS error code';

            return $this->fail_($step, $bucket, $code.' ('.get_class(AwsErrors::root($e)).')');
        }

        $this->line("PASS: put, get and delete of {$key} in bucket {$bucket}");

        return self::SUCCESS;
    }

    private function fail_(string $step, string $bucket, string $why): int
    {
        $this->line("FAIL at {$step} (bucket {$bucket}): {$why}");

        return self::FAILURE;
    }
}
