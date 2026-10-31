<?php

namespace App\Services\Push;

use App\Models\Channel;
use App\Models\User;

/**
 * What a notification says: who wrote, where, and a generic line. Never the message's text,
 * an e-mail address or a file name (the privacy rule of docs/known-limitations.md, "Push
 * notifications"); exactly these keys: type, title, body, url, tag. Written in the device's
 * language (lang/{en,he,fr}/push.php).
 */
final class PushPayload
{
    public const TYPE_DM = 'dm';

    public const TYPE_MENTION = 'mention';

    public const TYPE_REPLY = 'reply';

    public const TYPE_TEST = 'test';

    /**
     * @param  self::TYPE_DM|self::TYPE_MENTION|self::TYPE_REPLY  $type
     * @return array{type: string, title: string, body: string, url: string, tag: string}
     */
    public static function forMessage(string $type, User $sender, Channel $channel, ?int $threadId, string $locale): array
    {
        $name = self::senderName($sender, $locale);
        $title = $channel->isDirect()
            ? __('push.title_direct', ['sender' => $name], $locale)
            : __('push.title_room', ['sender' => $name, 'channel' => (string) $channel->name], $locale);

        return [
            'type' => $type,
            'title' => $title,
            'body' => __("push.body_{$type}", [], $locale),
            'url' => $threadId === null ? "/c/{$channel->id}" : "/c/{$channel->id}/t/{$threadId}",
            'tag' => self::tag($channel->id),
        ];
    }

    /** @return array{type: string, title: string, body: string, url: string, tag: string} */
    public static function test(string $locale): array
    {
        return [
            'type' => self::TYPE_TEST,
            'title' => __('push.test_title', [], $locale),
            'body' => __('push.test_body', [], $locale),
            'url' => '/',
            'tag' => 'test',
        ];
    }

    /**
     * The sender's name, unless it is (or holds) an e-mail address: a Google account without a
     * name is named by its address (GoogleIdentityProvider), which never goes into a notification.
     */
    public static function senderName(User $sender, string $locale): string
    {
        return str_contains($sender->name, '@') ? __('push.someone', [], $locale) : $sender->name;
    }

    /** One per conversation: a newer notification replaces the one before (and the push service's Topic). */
    public static function tag(int $channelId): string
    {
        return "channel-{$channelId}";
    }
}
