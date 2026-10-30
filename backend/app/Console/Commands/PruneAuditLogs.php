<?php

namespace App\Console\Commands;

use App\Models\AuditLog;
use Illuminate\Console\Command;

/** Deletes audit entries older than slax.audit.retention_days (SLAX_AUDIT_RETENTION_DAYS, 180 by default). */
class PruneAuditLogs extends Command
{
    protected $signature = 'audit:prune';

    protected $description = 'Delete audit log entries older than the retention period';

    public function handle(): int
    {
        $days = max(1, (int) config('slax.audit.retention_days', 180));
        $deleted = 0;

        // In batches: one long DELETE would hold its locks for the whole table.
        do {
            $batch = AuditLog::where('created_at', '<', now()->subDays($days))->orderBy('id')->limit(1000)->pluck('id');
            $deleted += AuditLog::whereKey($batch)->delete();
        } while ($batch->isNotEmpty());

        $this->info("Deleted {$deleted} audit entr".($deleted === 1 ? 'y' : 'ies')." older than {$days} days.");

        return self::SUCCESS;
    }
}
