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
