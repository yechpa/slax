<?php

namespace App\Http\Resources;

use App\Models\Channel;
use App\Services\ReadState;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * `is_member` comes from a `members_exists` aggregate when the caller loaded one
 * (the list), otherwise from `ChannelResource::withMembership()`. `member_count` comes
 * from a `members_count` aggregate when loaded. The caller's read state
 * (`last_read_message_id`, `unread_count`, see ReadState) is computed in bulk by the
 * list (`withReadState()`), otherwise for this channel alone.
 *
 * @mixin Channel
 */
class ChannelResource extends JsonResource
{
    private ?bool $isMember = null;

    /** @var array{last_read_message_id: ?int, unread_count: int}|null */
    private ?array $readState = null;

    /** A single channel whose membership the caller already knows. */
    public static function withMembership(Channel $channel, bool $isMember): static
    {
        $resource = new static($channel);
        $resource->isMember = $isMember;

        return $resource;
    }

    /** @param  array{last_read_message_id: ?int, unread_count: int}  $readState */
    public function withReadState(array $readState): static
    {
        $this->readState = $readState;

        return $this;
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $readState = $this->readState ?? ReadState::forChannels($request->user(), [$this->id])[$this->id];

        return [
            'id' => $this->id,
            'kind' => $this->kind,
            'name' => $this->name,
            'topic' => $this->topic,
            // Locked by an administrator: members read, only administrators post.
            'locked' => $this->isLocked(),
            'is_member' => $this->isMember ?? (bool) $this->members_exists,
            'member_count' => (int) ($this->members_count ?? $this->members()->count()),
            'last_read_message_id' => $readState['last_read_message_id'],
            // The true number: the client caps what it displays.
            'unread_count' => $readState['unread_count'],
            // Direct conversations have no name: the client titles them after their members.
            'members' => $this->when($this->isDirect(), fn () => $this->members->map(fn ($member) => [
                'id' => $member->id,
                'name' => $member->name,
                'avatar_url' => $member->avatar_url,
            ])->all()),
        ];
    }
}
