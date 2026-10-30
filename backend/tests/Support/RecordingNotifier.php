<?php

namespace Tests\Support;

use App\Contracts\AdminNotifier;
use App\Services\Alerts\AlertContext;

/** Keeps what would have been sent to the administrators (sanitised like the real notifier). */
class RecordingNotifier implements AdminNotifier
{
    /** @var list<array{level: string, title: string, context: array<string, scalar|null>}> */
    public array $alerts = [];

    public function notify(string $level, string $title, array $context = []): void
    {
        AlertContext::assertLevel($level);

        $this->alerts[] = ['level' => $level, 'title' => AlertContext::title($title), 'context' => AlertContext::sanitize($context)];
    }

    /** @return list<array{level: string, title: string, context: array<string, scalar|null>}> */
    public function withTitle(string $needle): array
    {
        return array_values(array_filter($this->alerts, fn (array $alert) => str_contains($alert['title'], $needle)));
    }
}
