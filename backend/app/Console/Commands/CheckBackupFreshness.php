<?php

namespace App\Console\Commands;

use App\Contracts\AdminNotifier;
use Carbon\CarbonImmutable;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * Production's database backups, seen from outside the backup pod: the newest dump in the
 * backups bucket (slax.backups) must be younger than max_age_hours, or the administrators get
 * a critical alert. A backup CronJob that stopped being scheduled, or whose pod was killed
 * before it could alert, is caught here. A dump's time is read from its name
 * (<prefix>/YYYY/MM/DD/slax-YYYYmmddTHHMMSSZ.dump), as restore-check.sh does.
 */
class CheckBackupFreshness extends Command
{
    protected $signature = 'backups:check-freshness';

    protected $description = 'Alert when the newest database backup in S3 is too old (or cannot be listed)';

    public const DISK = 'backups';

    public function handle(AdminNotifier $notifier): int
    {
        $bucket = config('slax.backups.bucket');
        if (blank($bucket)) {
            $this->info('No backups bucket configured (SLAX_BACKUP_BUCKET): nothing to check.');

            return self::SUCCESS;
        }
        $prefix = trim((string) config('slax.backups.prefix'), '/');
        $maxAge = (int) config('slax.backups.max_age_hours');

        try {
            $keys = Storage::disk(self::DISK)->allFiles($prefix);
        } catch (Throwable $e) {
            $notifier->notify('critical', 'Database backups cannot be listed', [
                'status' => 'list_failed',
                'exception' => $e::class,
            ]);
            $this->error('Listing the backups failed: '.$e::class);

            return self::FAILURE;
        }

        $newest = $this->newest($keys, $prefix);
        if ($newest === null) {
            $notifier->notify('critical', 'No database backup found', ['status' => 'missing', 'threshold' => $maxAge]);
            $this->error('No backup found.');

            return self::FAILURE;
        }

        $ageHours = (int) floor($newest->diffInMinutes(CarbonImmutable::now('UTC'), true) / 60);
        if ($ageHours >= $maxAge) {
            $notifier->notify('critical', 'Database backup is stale', [
                'status' => 'stale',
                'newest' => $newest->format('Y-m-d H:i').' UTC',
                'age_hours' => $ageHours,
                'threshold' => $maxAge,
            ]);
            $this->error("The newest backup is {$ageHours} hours old (limit {$maxAge}).");

            return self::FAILURE;
        }

        $this->info("The newest backup is {$ageHours} hours old (".$newest->format('Y-m-d H:i').' UTC).');

        return self::SUCCESS;
    }

    /** @param  list<string>  $keys */
    private function newest(array $keys, string $prefix): ?CarbonImmutable
    {
        $pattern = '#^'.preg_quote($prefix, '#').'/\d{4}/\d{2}/\d{2}/slax-(\d{8}T\d{6}Z)\.dump$#';
        $stamps = [];
        foreach ($keys as $key) {
            if (preg_match($pattern, $key, $match)) {
                $stamps[] = $match[1];
            }
        }
        if ($stamps === []) {
            return null;
        }
        sort($stamps);

        return CarbonImmutable::createFromFormat('Ymd\THis\Z', end($stamps), 'UTC') ?: null;
    }
}
