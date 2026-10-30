<?php

/*
 * Build step of docker/app/Dockerfile (run from the backend directory, before the autoloader
 * is dumped): keeps the AWS SDK's S3 client and removes the clients and models of the
 * hundreds of other AWS services (about 70 MB). The SDK's own Composer script
 * (Aws\Script\Composer\Composer::removeUnusedServices) does the same, but needs
 * composer.json changes that would also strip the development vendor directory; this
 * reuses its list of services that must never be removed (credential providers use them).
 */

$sdk = 'vendor/aws/aws-sdk-php/src/';
$keep = ['S3'];

require $sdk.'Script/Composer/Composer.php';
$neverRemove = (new ReflectionClass(Aws\Script\Composer\Composer::class))->getStaticPropertyValue('unsafeForDeletion');
$manifest = require $sdk.'data/manifest.json.php';

$removed = 0;
foreach ($manifest as $model => $attributes) {
    $client = $attributes['namespace'];
    if (in_array($client, $keep, true) || isset($neverRemove[$client])) {
        continue;
    }
    foreach ([$sdk.$client, $sdk.'data/'.$model] as $dir) {
        if (is_dir($dir)) {
            exec('rm -rf '.escapeshellarg($dir), $output, $status);
            if ($status !== 0) {
                fwrite(STDERR, "Could not remove {$dir}\n");
                exit(1);
            }
        }
    }
    $removed++;
}

if (! is_dir($sdk.'S3') || ! is_dir($sdk.'data/s3')) {
    fwrite(STDERR, "The S3 client is missing after trimming the AWS SDK\n");
    exit(1);
}

echo "AWS SDK: kept S3 and the credential providers' services, removed {$removed} others\n";
