<?php

namespace App\Console\Commands;

use App\Models\File;
use App\Services\FileUploads;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * Deletes uploads never attached to a message within File::UNATTACHED_TTL_HOURS (and
 * uploads interrupted before completion): the object first, then the row. A file whose
 * object cannot be deleted keeps its row, so the next run tries again.
 */
class PruneOrphanFiles extends Command
{
    protected $signature = 'files:prune-orphans';

    protected $description = 'Delete uploads left unattached for 24 hours (object and row)';

    public function handle(): int
    {
        $cutoff = now()->subHours(File::UNATTACHED_TTL_HOURS);
        $deleted = 0;
        $failed = 0;

        File::whereNull('message_id')->where('created_at', '<=', $cutoff)->select('id')
            ->chunkById(100, function ($candidates) use ($cutoff, &$deleted, &$failed) {
                foreach ($candidates as $candidate) {
                    match ($this->prune($candidate->id, $cutoff)) {
                        true => $deleted++,
                        false => $failed++,
                        null => null,
                    };
                }
            });

        $this->info("Deleted {$deleted} orphan file(s).");
        if ($failed > 0) {
            $this->error("{$failed} object(s) could not be deleted; their rows are kept for the next run.");

            return self::FAILURE;
        }

        return self::SUCCESS;
    }

    /**
     * With the row locked, so a message cannot attach the file while its object goes away.
     * Null when the file was attached (or removed) in the meantime.
     */
    private function prune(int $id, mixed $cutoff): ?bool
    {
        return DB::transaction(function () use ($id, $cutoff) {
            $file = File::whereKey($id)->whereNull('message_id')->where('created_at', '<=', $cutoff)->lockForUpdate()->first();
            if ($file === null) {
                return null;
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
}
