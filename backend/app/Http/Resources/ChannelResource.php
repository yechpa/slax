<?php

namespace App\Http\Resources;

use App\Models\Channel;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * `is_member` comes from a `members_exists` aggregate when the caller loaded one
 * (the list), otherwise from `ChannelResource::withMembership()`.
 *
 * @mixin Channel
 */
class ChannelResource extends JsonResource
{
    private ?bool $isMember = null;

    /** A single channel whose membership the caller already knows. */
    public static function withMembership(Channel $channel, bool $isMember): static
    {
        $resource = new static($channel);
        $resource->isMember = $isMember;

        return $resource;
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'kind' => $this->kind,
            'name' => $this->name,
            'topic' => $this->topic,
            'is_member' => $this->isMember ?? (bool) $this->members_exists,
            // Direct conversations have no name: the client titles them after their members.
            'members' => $this->when($this->isDirect(), fn () => $this->members->map(fn ($member) => [
                'id' => $member->id,
                'name' => $member->name,
                'avatar_url' => $member->avatar_url,
            ])->all()),
        ];
    }
}
