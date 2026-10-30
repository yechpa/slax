<?php

namespace App\Services\Push;

use App\Enums\PresenceState;
use App\Jobs\SendPushNotification;
use App\Models\Channel;
use App\Models\Message;
use App\Models\PushSubscription;
use App\Models\User;
use App\Services\PresenceService;

/**
 * Who gets a push for a new message, and with what: one SendPushNotification job per device.
 *
 * Notified, among the channel's members:
 *  - mention: the people the text @mentions (see Mentions), in any channel;
 *  - reply: on a thread reply, whoever wrote the thread's first message or an earlier reply;
 *  - dm: everyone in a direct or group conversation.
 * One notification per person, the first reason that applies in that order.
 *
 * Never: the author; a banned account; someone not (or no longer) a member; anyone online right
 * now. The server does not know whether a tab is visible, so that is the presence state
 * `online` (PresenceService): a heartbeat in the last 60 s and an interaction with Slax in the
 * last 5 minutes, on any device. `away` (a tab open without interaction for 5 minutes, e.g. in
 * the background) and `offline` are notified.
 */
class PushNotifier
{
    public function __construct(private readonly PresenceService $presence) {}

    /** @return int jobs queued */
    public function messageCreated(Message $message): int
    {
        if (! Push::enabled() || $message->isDeleted()) {
            return 0;
        }
        $channel = $message->channel;
        $author = $message->user;

        /** @var array<int, string> $members name by id: members other than the author, not banned */
        $members = $channel->members()
            ->where('users.id', '!=', $author->id)
            ->whereNull('users.banned_at')
            ->pluck('users.name', 'users.id')
            ->all();
        if ($members === []) {
            return 0;
        }

        $reasons = [];
        foreach (Mentions::mentioned((string) $message->body, $members) as $id) {
            $reasons[$id] = PushPayload::TYPE_MENTION;
        }
        if ($message->isReply()) {
            $thread = Message::where(fn ($query) => $query->whereKey($message->parent_id)->orWhere('parent_id', $message->parent_id))
                ->whereKeyNot($message->id)
                ->distinct()
                ->pluck('user_id');
            foreach ($thread as $id) {
                if (isset($members[$id])) {
                    $reasons[$id] ??= PushPayload::TYPE_REPLY;
                }
            }
        }
        if ($channel->isDirect()) {
            foreach (array_keys($members) as $id) {
                $reasons[$id] ??= PushPayload::TYPE_DM;
            }
        }
        if ($reasons === []) {
            return 0;
        }

        // Online (connected and active): they see it in the app.
        $away = array_keys(array_filter($this->presence->statesOf(array_keys($reasons)), fn (string $state) => $state !== PresenceState::Online->value));
        if ($away === []) {
            return 0;
        }

        $queued = 0;
        foreach (PushSubscription::whereIn('user_id', $away)->orderBy('id')->get() as $device) {
            $payload = PushPayload::forMessage($reasons[$device->user_id], $author, $channel, $message->parent_id, $device->locale);
            SendPushNotification::dispatch($device->id, $channel->id, $message->id, $payload);
            $queued++;
        }

        return $queued;
    }

    /** The test button: every device of $user, whatever their presence. @return int devices */
    public function test(User $user): int
    {
        $devices = PushSubscription::where('user_id', $user->id)->orderBy('id')->get();
        foreach ($devices as $device) {
            SendPushNotification::dispatch($device->id, null, null, PushPayload::test($device->locale));
        }

        return $devices->count();
    }
}
