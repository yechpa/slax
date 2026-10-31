<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

Schedule::command('files:prune-orphans')->hourly()->withoutOverlapping();

// The public demo goes back to its seed every night (DemoReset), at a quiet hour for its audience.
Schedule::command('slax:demo-reset')
    ->dailyAt(config('slax.demo.reset_time', '03:00'))
    ->timezone(config('slax.demo.reset_timezone', 'Asia/Jerusalem'))
    ->when(fn () => (bool) config('slax.demo.reset_enabled'))
    ->withoutOverlapping()
    ->onOneServer();

// The audit log keeps slax.audit.retention_days (180 by default).
Schedule::command('audit:prune')->dailyAt('04:30')->withoutOverlapping()->onOneServer();

// Production's database backups must keep coming (BackupFreshness): checked from here, outside
// the backup pod, every morning. Off where no backups bucket is configured.
Schedule::command('backups:check-freshness')
    ->dailyAt('09:00')
    ->timezone('Asia/Jerusalem')
    ->when(fn () => filled(config('slax.backups.bucket')))
    ->withoutOverlapping()
    ->onOneServer();
