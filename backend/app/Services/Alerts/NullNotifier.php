<?php

namespace App\Services\Alerts;

use App\Contracts\AdminNotifier;

/** Tests, and environments without Telegram credentials: alerts go nowhere. */
class NullNotifier implements AdminNotifier
{
    public function notify(string $level, string $title, array $context = []): void
    {
        AlertContext::assertLevel($level);
    }
}
