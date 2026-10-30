<?php

namespace App\Logging;

use Monolog\Logger;

/** The `telegram` log channel (config/logging.php): errors and above, to the administrators. */
class CreateTelegramLogger
{
    /** @param array<string, mixed> $config */
    public function __invoke(array $config): Logger
    {
        return new Logger('telegram', [new TelegramLogHandler($config['level'] ?? 'error')]);
    }
}
