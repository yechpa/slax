<?php

use App\Contracts\AdminNotifier;
use Aws\Command as AwsCommand;
use Aws\S3\Exception\S3Exception;
use Illuminate\Console\Scheduling\Event as ScheduledEvent;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Sleep;
use League\Flysystem\UnableToListContents;
use Tests\Support\RecordingNotifier;

beforeEach(function () {
    config(['slax.backups.bucket' => 'slax-backups-example', 'slax.backups.prefix' => 'pg', 'slax.backups.max_age_hours' => 30]);
    $this->notifier = new RecordingNotifier;
    app()->instance(AdminNotifier::class, $this->notifier);
    Storage::fake('backups');
    $this->travelTo(now('UTC')->setDate(2026, 10, 30)->setTime(9, 0));
});

/** A dump as pg-backup.sh names it, taken $hoursAgo hours before now. */
function dumpTaken(float $hoursAgo): string
{
    $at = now('UTC')->subMinutes((int) round($hoursAgo * 60));
    $key = 'pg/'.$at->format('Y/m/d').'/slax-'.$at->format('Ymd\THis\Z').'.dump';
    Storage::disk('backups')->put($key, 'PGDMP');

    return $key;
}

test('a fresh backup raises no alert', function () {
    dumpTaken(50);
    dumpTaken(6.5);

    $this->artisan('backups:check-freshness')->assertSuccessful();

    expect($this->notifier->alerts)->toBe([]);
});

test('a stale newest backup raises a critical alert with its age only', function () {
    dumpTaken(80);
    dumpTaken(31);
    Storage::disk('backups')->put('pg/notes.txt', 'not a dump');
    Storage::disk('backups')->put('other/2026/10/30/slax-20261030T080000Z.dump', 'outside the prefix');

    $this->artisan('backups:check-freshness')->assertFailed();

    expect($this->notifier->alerts)->toHaveCount(1);
    $alert = $this->notifier->alerts[0];
    expect($alert['level'])->toBe('critical')
        ->and($alert['title'])->toBe('Database backup is stale')
        ->and($alert['context'])->toEqual([
            'status' => 'stale',
            'threshold' => 30,
            'age_hours' => 31,
            'newest' => now('UTC')->subMinutes(31 * 60)->format('Y-m-d H:i').' UTC',
        ]);
});

test('no backup at all raises a critical alert', function () {
    Storage::disk('backups')->put('pg/2026/10/30/garbage.dump', 'misnamed');

    $this->artisan('backups:check-freshness')->assertFailed();

    expect($this->notifier->alerts)->toHaveCount(1)
        ->and($this->notifier->alerts[0]['level'])->toBe('critical')
        ->and($this->notifier->alerts[0]['title'])->toBe('No database backup found')
        ->and($this->notifier->alerts[0]['context']['status'])->toBe('missing');
});

function deniedListing(): UnableToListContents
{
    return UnableToListContents::atLocation('pg', true, new S3Exception(
        'Access Denied for arn:aws:iam::123456789012:role/x',
        new AwsCommand('ListObjectsV2'),
        ['code' => 'AccessDenied'],
    ));
}

test('a persistent listing error raises a critical alert with the root class and AWS code, never the message', function () {
    Sleep::fake();
    $disk = Mockery::mock(Filesystem::class);
    $disk->shouldReceive('allFiles')->with('pg')->twice()->andThrow(deniedListing());
    Storage::set('backups', $disk);

    $this->artisan('backups:check-freshness')->assertFailed();

    Sleep::assertSleptTimes(1);
    expect($this->notifier->alerts)->toHaveCount(1);
    $alert = $this->notifier->alerts[0];
    expect($alert['level'])->toBe('critical')
        ->and($alert['title'])->toBe('Database backups cannot be listed')
        ->and($alert['context'])->toEqual(['status' => 'list_failed', 'exception' => S3Exception::class, 'aws_error' => 'AccessDenied'])
        ->and(json_encode($alert))->not->toContain('123456789012');
});

test('a single listing blip is retried once and raises nothing', function () {
    Sleep::fake();
    $at = now('UTC')->subHours(6);
    $disk = Mockery::mock(Filesystem::class);
    $calls = 0;
    $disk->shouldReceive('allFiles')->with('pg')->twice()->andReturnUsing(function () use (&$calls, $at) {
        if (++$calls === 1) {
            throw deniedListing();
        }

        return ['pg/'.$at->format('Y/m/d').'/slax-'.$at->format('Ymd\\THis\\Z').'.dump'];
    });
    Storage::set('backups', $disk);

    $this->artisan('backups:check-freshness')->assertSuccessful();

    Sleep::assertSleptTimes(1);
    expect($this->notifier->alerts)->toBe([]);
});

test('without a backups bucket nothing is checked (dev, e2e, tests)', function () {
    config(['slax.backups.bucket' => null]);
    $disk = Mockery::mock(Filesystem::class);
    $disk->shouldNotReceive('allFiles');
    Storage::set('backups', $disk);

    $this->artisan('backups:check-freshness')->assertSuccessful();

    expect($this->notifier->alerts)->toBe([]);
});

test('it is scheduled every morning in Jerusalem, once, only where a backups bucket is configured', function () {
    $events = collect(app(Schedule::class)->events())
        ->filter(fn (ScheduledEvent $event) => str_contains((string) $event->command, 'backups:check-freshness'));

    expect($events)->toHaveCount(1);
    $event = $events->first();
    expect($event->expression)->toBe('0 9 * * *')
        ->and((string) $event->timezone)->toBe('Asia/Jerusalem')
        ->and($event->withoutOverlapping)->toBeTrue()
        ->and($event->onOneServer)->toBeTrue()
        ->and($event->filtersPass(app()))->toBeTrue();

    config(['slax.backups.bucket' => null]);
    expect($event->filtersPass(app()))->toBeFalse();
});
