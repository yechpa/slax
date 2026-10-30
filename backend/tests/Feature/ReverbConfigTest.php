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
