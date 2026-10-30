<?php

namespace App\Services\Alerts;

use App\Contracts\AdminNotifier;

/**
 * Telegram when both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set (from the environment,
 * never from the repository), nothing otherwise: a development stack without those secrets
 * works as usual. Automated tests never reach Telegram, whatever is configured.
 */
final class NotifierFactory
{
    public static function make(string $environment): AdminNotifier
    {
        $token = (string) config('services.telegram.bot_token');
        $chatId = (string) config('services.telegram.chat_id');

        if ($environment === 'testing' || $token === '' || $chatId === '') {
            return new NullNotifier;
        }

        return new TelegramNotifier($token, $chatId, app('redis'));
    }
}
