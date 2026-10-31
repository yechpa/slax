<?php

namespace App\Contracts;

use InvalidArgumentException;

/**
 * Alerts for the administrators (a Telegram bot in deployed environments, nothing in tests
 * or when unconfigured; see NotifierFactory).
 *
 * Implementations never throw because sending failed and never block on it for long; they
 * drop every context key outside AlertContext's allowlist, so a message body, an e-mail
 * address or a name can never reach the chat. Identical alerts are grouped for 5 minutes.
 */
interface AdminNotifier
{
    public const LEVELS = ['info', 'warning', 'error', 'critical'];

    /**
     * @param  string  $level  one of LEVELS
     * @param  array<string, mixed>  $context  ids, counts, status codes, route names, exception classes
     *
     * @throws InvalidArgumentException for a level outside LEVELS (a programming error)
     */
    public function notify(string $level, string $title, array $context = []): void;
}
