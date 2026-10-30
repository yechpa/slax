<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Minishlink\WebPush\VAPID;

/**
 * A new VAPID key pair for Web Push, printed as two env lines. Nothing is written anywhere:
 * the operator puts the pair in the deployment's Secret (docs/runbook.md, "Push
 * notifications"). A new pair invalidates every existing subscription (people turn
 * notifications on again).
 */
class PushKeys extends Command
{
    protected $signature = 'slax:push-keys';

    protected $description = 'Print a fresh VAPID key pair for Web Push (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY); writes nothing';

    public function handle(): int
    {
        $keys = VAPID::createVapidKeys();

        $this->line('VAPID_PUBLIC_KEY='.$keys['publicKey']);
        $this->line('VAPID_PRIVATE_KEY='.$keys['privateKey']);

        return self::SUCCESS;
    }
}
