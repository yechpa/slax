<?php

namespace App\Services;

use App\Exceptions\FileRejected;
use App\Exceptions\ScannerUnavailable;
use App\Exceptions\StorageUnavailable;
use App\Models\Channel;
use App\Models\File;
use App\Models\User;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * Accepting an upload, in this order:
 *
 *  1. Size of the bytes actually received (1 byte to 10 MB) and an early quota check.
 *  2. The scanner's verdict. Unreachable: ScannerUnavailable (503), nothing stored.
 *  3. Reservation, in one transaction with the account row locked: quota check on the
 *     current total, then insert of the row as `pending`. Concurrent uploads of one
 *     account queue on that lock, so together they never exceed the quota.
 *  4. Object write, then the row becomes `clean`. If either fails, the object is deleted,
 *     then the row, before the error goes up. A row that survives that (object delete
 *     refused, crash, database gone) stays `pending` and unattached: files:prune-orphans
 *     deletes its object then itself after 24 hours. So an object never outlives its row.
 */
class FileUploads
{
    public const DISK = 's3';

    public function __construct(private readonly ScannerClient $scanner) {}

    public function store(User $user, Channel $channel, UploadedFile $upload): File
    {
        $path = (string) $upload->getRealPath();
        clearstatcache(true, $path);
        $size = @filesize($path);
        if ($size === false || $size < 1) {
            throw new FileRejected('empty_file');
        }
        if ($size > File::MAX_BYTES) {
            throw new FileRejected('too_large');
        }
        // Spares the scanner a file that cannot fit; the decisive check is in reserve().
        if (File::usedBytes($user) + $size > File::ACCOUNT_QUOTA_BYTES) {
            throw new FileRejected('quota_exceeded');
        }

        $scan = $this->scanner->scan($upload);
        if (! $scan->ok) {
            throw new FileRejected($scan->reason ?? 'rejected');
        }
        if (! array_key_exists($scan->detectedMime, File::EXTENSIONS)) {
            throw new FileRejected('type_not_allowed');
        }
        $sha256 = (string) hash_file('sha256', $path);
        if (! hash_equals($sha256, $scan->sha256)) {
            throw new ScannerUnavailable('The scanner reported the hash of other content.');
        }

        $file = $this->reserve($user, [
            'user_id' => $user->id,
            'channel_id' => $channel->id,
            'storage_key' => File::newStorageKey(),
            'display_name' => FileNames::forDisplay($upload->getClientOriginalName(), $scan->detectedMime),
            'mime' => $scan->detectedMime,
            'size' => $size,
            'sha256' => $sha256,
            'scan_status' => File::STATUS_PENDING,
        ]);
        $this->writeObject($file, $path);

        return $file;
    }

    /** @param array<string, mixed> $attributes */
    private function reserve(User $user, array $attributes): File
    {
        return DB::transaction(function () use ($user, $attributes) {
            User::whereKey($user->id)->lockForUpdate()->first();

            if (File::usedBytes($user) + $attributes['size'] > File::ACCOUNT_QUOTA_BYTES) {
                throw new FileRejected('quota_exceeded');
            }

            return File::create($attributes);
        });
    }

    private function writeObject(File $file, string $path): void
    {
        $disk = Storage::disk(self::DISK);

        try {
            $stream = @fopen($path, 'rb');
            $written = $stream !== false && $disk->put($file->storage_key, $stream, ['ContentType' => $file->mime]);
            if (is_resource($stream)) {
                fclose($stream);
            }
            if (! $written) {
                throw new StorageUnavailable('The file could not be written to object storage.');
            }

            $file->forceFill(['scan_status' => File::STATUS_CLEAN])->save();
        } catch (Throwable $e) {
            $this->discard($file);

            throw $e;
        }
    }

    /**
     * Object first, then the row. The row stays (still `pending`, so files:prune-orphans
     * retries) unless the object is known to be gone: never an object without its row.
     */
    private function discard(File $file): void
    {
        try {
            if (! Storage::disk(self::DISK)->delete($file->storage_key)) {
                return;
            }
            $file->delete();
        } catch (Throwable $e) {
            report($e);
        }
    }
}
