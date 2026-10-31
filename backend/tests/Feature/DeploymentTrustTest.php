<?php

use Aws\S3\S3Client;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Storage;

/*
 * Production assumptions the deployment relies on (deploy/aws, values-prod.yaml).
 */

test('Laravel trusts no proxy: the client address is REMOTE_ADDR, never X-Forwarded-For', function () {
    // nginx (slax-web) has already replaced REMOTE_ADDR with the visitor's address from its
    // trusted proxies; trusting the header again here would let any client choose its own
    // address for rate limits, Turnstile and the audit log.
    Route::get('/api/v1/__test/ip', fn (Request $request) => ['ip' => $request->ip()]);

    $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])
        ->withHeaders(['X-Forwarded-For' => '6.6.6.6', 'X-Real-IP' => '6.6.6.6', 'Forwarded' => 'for=6.6.6.6'])
        ->getJson('/api/v1/__test/ip')
        ->assertOk()
        ->assertExactJson(['ip' => '203.0.113.9']);
});

test('without static keys, the S3 disks use the AWS default credential chain (the instance role)', function () {
    // Production gives no AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (s3.useInstanceRole): the
    // SDK must then look the credentials up itself (environment, then the EC2 instance
    // role). The environment provider, first in that chain, stands in for the role here.
    config([
        'filesystems.disks.s3.key' => null,
        'filesystems.disks.s3.secret' => null,
        'filesystems.disks.s3-public.key' => null,
        'filesystems.disks.s3-public.secret' => null,
        'filesystems.disks.s3.region' => 'eu-central-1',
        'filesystems.disks.s3-public.region' => 'eu-central-1',
    ]);
    $saved = ['AWS_ACCESS_KEY_ID' => getenv('AWS_ACCESS_KEY_ID'), 'AWS_SECRET_ACCESS_KEY' => getenv('AWS_SECRET_ACCESS_KEY')];
    putenv('AWS_ACCESS_KEY_ID=ASIA-FROM-THE-CHAIN');
    putenv('AWS_SECRET_ACCESS_KEY=secret-from-the-chain');

    try {
        foreach (['s3', 's3-public'] as $disk) {
            Storage::forgetDisk($disk);
            /** @var S3Client $client */
            $client = Storage::disk($disk)->getClient();
            expect($client->getCredentials()->wait()->getAccessKeyId())->toBe('ASIA-FROM-THE-CHAIN');
        }
    } finally {
        foreach ($saved as $name => $value) {
            putenv($value === false ? $name : "$name=$value");
        }
        Storage::forgetDisk(['s3', 's3-public']);
    }
});

test('presigned downloads on AWS name the bucket host the CSP allows', function () {
    // values-prod.yaml derives the CSP img-src from bucket and region:
    // https://<bucket>.s3.<region>.amazonaws.com. The URLs the app signs must use that host.
    config([
        'filesystems.disks.s3-public.key' => 'AKIDEXAMPLE',
        'filesystems.disks.s3-public.secret' => 'example',
        'filesystems.disks.s3-public.region' => 'eu-central-1',
        'filesystems.disks.s3-public.bucket' => 'slax-files-example',
        'filesystems.disks.s3-public.endpoint' => null,
        'filesystems.disks.s3-public.use_path_style_endpoint' => false,
    ]);
    Storage::forgetDisk('s3-public');

    $url = Storage::disk('s3-public')->temporaryUrl('f/1.png', now()->addMinute(), [
        'ResponseContentType' => 'image/png',
        'ResponseContentDisposition' => 'inline',
    ]);

    expect(parse_url($url, PHP_URL_SCHEME).'://'.parse_url($url, PHP_URL_HOST))
        ->toBe('https://slax-files-example.s3.eu-central-1.amazonaws.com');
    Storage::forgetDisk('s3-public');
});
