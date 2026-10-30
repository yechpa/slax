<?php

use Aws\Command as AwsCommand;
use Aws\S3\Exception\S3Exception;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Storage;
use League\Flysystem\UnableToWriteFile;

test('PASS: put, get and delete under files/, nothing left behind', function () {
    Storage::fake('s3');

    $this->artisan('slax:s3-probe')
        ->expectsOutputToContain('PASS: put, get and delete of files/probe/slax-s3-probe-')
        ->assertSuccessful();

    expect(Storage::disk('s3')->allFiles())->toBe([]);
});

test('the probe forces the disk to throw, so a refusal is never a silent false', function () {
    config(['filesystems.disks.s3.throw' => false]);
    Storage::fake('s3');

    $this->artisan('slax:s3-probe')->assertSuccessful();

    expect(config('filesystems.disks.s3.throw'))->toBeTrue();
});

test('FAIL with the AWS error code and the root class, never the message', function () {
    $denied = new S3Exception(
        'Access Denied for arn:aws:iam::123456789012:role/slax-prod-instance',
        new AwsCommand('PutObject'),
        ['code' => 'AccessDenied'],
    );
    $disk = Mockery::mock(Filesystem::class);
    $disk->shouldReceive('put')->andThrow(UnableToWriteFile::atLocation('files/probe/x', 'denied', $denied));
    Storage::set('s3', $disk);

    $status = Artisan::call('slax:s3-probe');
    $output = Artisan::output();

    expect($status)->toBe(1)
        ->and($output)->toContain('FAIL at put')
        ->and($output)->toContain('AccessDenied ('.S3Exception::class.')')
        ->and($output)->not->toContain('123456789012');
});

test('FAIL when a write returns false or the object reads back wrong', function () {
    $disk = Mockery::mock(Filesystem::class);
    $disk->shouldReceive('put')->andReturn(false);
    Storage::set('s3', $disk);
    $this->artisan('slax:s3-probe')->expectsOutputToContain('FAIL at put')->assertFailed();

    $disk = Mockery::mock(Filesystem::class);
    $disk->shouldReceive('put')->andReturn(true);
    $disk->shouldReceive('get')->andReturn('something else');
    Storage::set('s3', $disk);
    $this->artisan('slax:s3-probe')->expectsOutputToContain('FAIL at get')->assertFailed();
});
