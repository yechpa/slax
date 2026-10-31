<?php

namespace App\Logging;

use App\Contracts\AdminNotifier;
use Monolog\Handler\AbstractProcessingHandler;
use Monolog\Level;
use Monolog\LogRecord;
use Throwable;

/**
 * Relays error, critical, alert and emergency records to the AdminNotifier.
 *
 * The log message itself never leaves: it may carry anything (an exception message quotes
 * SQL with its bindings, hence message bodies). The alert says what failed and where: the
 * exception class, file and line, the route, and a short digest of the message to find the
 * full record in the local logs. A record logged while relaying (the notifier logging its
 * own failure, say) is not relayed again.
 */
class TelegramLogHandler extends AbstractProcessingHandler
{
    private static bool $relaying = false;

    public function __construct(int|string|Level $level = Level::Error, bool $bubble = true)
    {
        parent::__construct($level, $bubble);
    }

    protected function write(LogRecord $record): void
    {
        if (self::$relaying) {
            return;
        }
        self::$relaying = true;

        try {
            [$title, $context] = self::describe($record);
            app(AdminNotifier::class)->notify($record->level->isHigherThan(Level::Error) ? 'critical' : 'error', $title, $context);
        } catch (Throwable) {
            // Logging must never fail because alerting did.
        } finally {
            self::$relaying = false;
        }
    }

    /** @return array{0: string, 1: array<string, scalar>} */
    private static function describe(LogRecord $record): array
    {
        $context = [
            'log_channel' => $record->channel,
            'digest' => substr(hash('sha256', $record->message), 0, 10),
        ];

        $exception = $record->context['exception'] ?? null;
        if ($exception instanceof Throwable) {
            $context['exception'] = $exception::class;
            $context['location'] = basename($exception->getFile()).':'.$exception->getLine();
            $title = 'Unhandled '.class_basename($exception);
        } else {
            $title = 'Logged '.strtolower($record->level->getName());
        }

        try {
            $request = app()->bound('request') ? app('request') : null;
            if ($request !== null && ($route = $request->route()) !== null) {
                $context['route'] = $route->uri();
                $context['method'] = $request->method();
            }
        } catch (Throwable) {
            // No request context (console, early boot).
        }

        return [$title, $context];
    }
}
