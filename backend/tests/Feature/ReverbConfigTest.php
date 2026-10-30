<?php

/** Reads config/reverb.php's single application with REVERB_ALLOWED_ORIGINS set to $value (null: unset). */
function reverbAppWithOrigins(?string $value): array
{
    $previous = [$_ENV['REVERB_ALLOWED_ORIGINS'] ?? null, $_SERVER['REVERB_ALLOWED_ORIGINS'] ?? null];
    unset($_ENV['REVERB_ALLOWED_ORIGINS'], $_SERVER['REVERB_ALLOWED_ORIGINS']);
    if ($value !== null) {
        $_ENV['REVERB_ALLOWED_ORIGINS'] = $_SERVER['REVERB_ALLOWED_ORIGINS'] = $value;
    }

    try {
        return (require config_path('reverb.php'))['apps']['apps'][0];
    } finally {
        unset($_ENV['REVERB_ALLOWED_ORIGINS'], $_SERVER['REVERB_ALLOWED_ORIGINS']);
        [$env, $server] = $previous;
        if ($env !== null) {
            $_ENV['REVERB_ALLOWED_ORIGINS'] = $env;
        }
        if ($server !== null) {
            $_SERVER['REVERB_ALLOWED_ORIGINS'] = $server;
        }
    }
}

test('a deployment limits WebSocket origins to its own hosts', function () {
    expect(reverbAppWithOrigins('dev.slax.yechpa.com, other.example')['allowed_origins'])
        ->toBe(['dev.slax.yechpa.com', 'other.example']);
});

test('any origin is accepted when nothing is configured (local stacks)', function () {
    expect(reverbAppWithOrigins(null)['allowed_origins'])->toBe(['*']);
});

/** config/reverb.php's single application with these environment variables set (null: unset). */
function reverbAppWith(array $variables): array
{
    $previous = [];
    foreach ($variables as $name => $value) {
        $previous[$name] = [$_ENV[$name] ?? null, $_SERVER[$name] ?? null];
        unset($_ENV[$name], $_SERVER[$name]);
        if ($value !== null) {
            $_ENV[$name] = $_SERVER[$name] = $value;
        }
    }

    try {
        return (require config_path('reverb.php'))['apps']['apps'][0];
    } finally {
        foreach ($previous as $name => [$env, $server]) {
            unset($_ENV[$name], $_SERVER[$name]);
            if ($env !== null) {
                $_ENV[$name] = $env;
            }
            if ($server !== null) {
                $_SERVER[$name] = $server;
            }
        }
    }
}

const REVERB_LIMIT_VARIABLES = ['REVERB_APP_RATE_LIMITING_ENABLED', 'REVERB_APP_RATE_LIMIT_MAX_ATTEMPTS', 'REVERB_APP_RATE_LIMIT_DECAY_SECONDS', 'REVERB_APP_RATE_LIMIT_TERMINATE', 'REVERB_APP_MAX_CONNECTIONS'];

test('every socket is rate limited by default: 300 frames a minute, refused beyond, never cut', function () {
    $app = reverbAppWith(array_fill_keys(REVERB_LIMIT_VARIABLES, null));

    // Reverb enables it only for a strict `true`, and counts every frame (subscriptions included).
    expect($app['rate_limiting'])->toBe(['enabled' => true, 'max_attempts' => 300, 'decay_seconds' => 60, 'terminate_on_limit' => false])
        ->and($app['max_connections'])->toBeNull();
});

test('the limits read from the environment are typed as Reverb expects them', function () {
    $app = reverbAppWith([
        'REVERB_APP_RATE_LIMITING_ENABLED' => 'true',
        'REVERB_APP_RATE_LIMIT_MAX_ATTEMPTS' => '400',
        'REVERB_APP_RATE_LIMIT_DECAY_SECONDS' => '30',
        'REVERB_APP_RATE_LIMIT_TERMINATE' => 'false',
        'REVERB_APP_MAX_CONNECTIONS' => '500',
    ]);
    expect($app['rate_limiting'])->toBe(['enabled' => true, 'max_attempts' => 400, 'decay_seconds' => 30, 'terminate_on_limit' => false])
        ->and($app['max_connections'])->toBe(500)
        ->and(reverbAppWith(['REVERB_APP_RATE_LIMITING_ENABLED' => 'false'])['rate_limiting']['enabled'])->toBeFalse();
});
