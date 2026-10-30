<?php

/** config/queue.php read again with REDIS_QUEUE_BLOCK_FOR set to $value (null: unset). */
function redisQueueConfigWith(?string $value): array
{
    $saved = [$_ENV['REDIS_QUEUE_BLOCK_FOR'] ?? null, $_SERVER['REDIS_QUEUE_BLOCK_FOR'] ?? null, getenv('REDIS_QUEUE_BLOCK_FOR')];
    $set = function (?string $v) {
        if ($v === null) {
            unset($_ENV['REDIS_QUEUE_BLOCK_FOR'], $_SERVER['REDIS_QUEUE_BLOCK_FOR']);
            putenv('REDIS_QUEUE_BLOCK_FOR');
        } else {
            $_ENV['REDIS_QUEUE_BLOCK_FOR'] = $_SERVER['REDIS_QUEUE_BLOCK_FOR'] = $v;
            putenv("REDIS_QUEUE_BLOCK_FOR={$v}");
        }
    };
    try {
        $set($value);

        return (require config_path('queue.php'))['connections']['redis'];
    } finally {
        $set($saved[2] === false ? null : $saved[2]);
        if ($saved[0] !== null) {
            $_ENV['REDIS_QUEUE_BLOCK_FOR'] = $saved[0];
        }
        if ($saved[1] !== null) {
            $_SERVER['REDIS_QUEUE_BLOCK_FOR'] = $saved[1];
        }
    }
}

test('a queue worker can wait on Redis for its next job instead of polling (REDIS_QUEUE_BLOCK_FOR)', function () {
    // The e2e worker (docker-compose.e2e.yml) runs with --sleep=0 and block_for 1: a job is
    // taken the moment it is pushed, and an idle worker does not poll Redis without pause.
    expect(redisQueueConfigWith('1')['block_for'])->toBe(1)
        // Unset: Laravel's default, poll then sleep.
        ->and(redisQueueConfigWith(null)['block_for'])->toBeNull();
});
