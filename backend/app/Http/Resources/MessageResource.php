<?php

namespace App\Http\Resources;

use App\Models\File;
use App\Models\Message;
use App\Models\Reaction;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * Expects a message loaded with Message::scopeForDisplay().
 * A deleted message renders as a tombstone: no author, body, reactions or files.
 *
 * @mixin Message
 */
class MessageResource extends JsonResource
{
    /**
     * Reactors listed per emoji (in order of reaction); `count` stays the true total.
     * Keeps payloads, broadcasts included, well under Reverb's request size limit.
     */
    public const MAX_REACTION_USER_IDS = 50;

    /** Broadcast payloads go to every member alike: nobody is "me". */
    private bool $forEveryone = false;

    /** @return array<string, mixed> */
    public static function forBroadcast(Message $message): array
    {
        $resource = new static($message);
        $resource->forEveryone = true;

        return $resource->resolve();
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $message = [
            'id' => $this->id,
            'channel_id' => $this->channel_id,
            'parent_id' => $this->parent_id,
            'created_at' => $this->created_at->toISOString(),
        ];
        // Thread summary; replies have no thread of their own.
        $thread = [
            'reply_count' => $this->isReply() ? 0 : (int) $this->reply_count,
            'last_reply_at' => $this->isReply() ? null : $this->last_reply_at?->toISOString(),
        ];

        if ($this->isDeleted()) {
            return $message + ['deleted' => true] + $thread;
        }

        return $message + [
            'client_id' => $this->client_id,
            'user' => [
                'id' => $this->user->id,
                'name' => $this->user->name,
                'avatar_url' => $this->user->avatar_url,
            ],
            'body' => $this->body,
            'edited_at' => $this->edited_at?->toISOString(),
            'deleted' => false,
            'reactions' => $this->reactionSummary($this->forEveryone ? null : $request->user()?->id),
            'files' => $this->files->map(fn (File $file) => (new FileResource($file))->resolve($request))->all(),
        ] + $thread;
    }

    /**
     * One entry per emoji, in order of first use; the first MAX_REACTION_USER_IDS reactors.
     *
     * @return list<array{emoji: string, count: int, reacted_by_me: bool, user_ids: list<int>}>
     */
    private function reactionSummary(?int $viewerId): array
    {
        return $this->reactions
            ->sortBy('id')
            ->groupBy(fn (Reaction $reaction) => $reaction->emoji)
            ->map(fn ($group, $emoji) => [
                'emoji' => (string) $emoji,
                'count' => $group->count(),
                'reacted_by_me' => $viewerId !== null && $group->contains('user_id', $viewerId),
                'user_ids' => $group->pluck('user_id')->take(self::MAX_REACTION_USER_IDS)->values()->all(),
            ])
            ->values()
            ->all();
    }
}
