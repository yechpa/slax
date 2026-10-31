<?php

namespace App\Support;

use Aws\Exception\AwsException;
use Throwable;

/**
 * What may be said about a storage error: the class of the root exception and the AWS error
 * code (AccessDenied, NoSuchBucket, ...), never the message (it can carry ARNs, account ids,
 * keys of objects).
 */
final class AwsErrors
{
    /** The innermost exception (Flysystem wraps the SDK's). */
    public static function root(Throwable $e): Throwable
    {
        while ($e->getPrevious() !== null) {
            $e = $e->getPrevious();
        }

        return $e;
    }

    /** The AWS error code anywhere in the chain, if any. */
    public static function code(Throwable $e): ?string
    {
        for ($current = $e; $current !== null; $current = $current->getPrevious()) {
            if ($current instanceof AwsException && $current->getAwsErrorCode()) {
                return (string) $current->getAwsErrorCode();
            }
        }

        return null;
    }
}
