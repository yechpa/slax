<?php

namespace App\Services;

use App\Models\File;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * Deleting stored files for good (moderation, demo reset): the object first, then the row,
 * with the row locked meanwhile. If object storage refuses or cannot be reached, the row
 * stays, so nothing points at a missing object and nothing in the bucket is forgotten: the
 * caller can retry. Quotas follow, since they add up the rows (File::usedBytes).
 */
class StoredFiles
{
    /** Whether the file is gone (also when it was already gone). */
    public function delete(int $fileId): bool
    {
        return DB::transaction(function () use ($fileId) {
            $file = File::whereKey($fileId)->lockForUpdate()->first();
            if ($file === null) {
                return true;
            }

            try {
                $gone = Storage::disk(FileUploads::DISK)->delete($file->storage_key);
            } catch (Throwable $e) {
                report($e);
                $gone = false;
            }
            if (! $gone) {
                return false;
            }

            $file->delete();

            return true;
        });
    }

    /**
     * @param  iterable<int>  $fileIds
     * @return list<int> the ids that could not be deleted
     */
    public function deleteMany(iterable $fileIds): array
    {
        $failed = [];
        foreach ($fileIds as $id) {
            if (! $this->delete((int) $id)) {
                $failed[] = (int) $id;
            }
        }

        return $failed;
    }
}
