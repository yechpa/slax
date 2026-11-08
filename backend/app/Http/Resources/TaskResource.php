<?php

namespace App\Http\Resources;

use App\Models\Task;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * Load `creator` and `assignee` first (TaskController does). People appear as id, name and avatar only:
 * never an e-mail address. No `position`: the server orders, and a number seen by someone other than the holder
 * would tell them how many tasks the holder has, private ones included.
 *
 * @mixin Task
 */
class TaskResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'title' => $this->title,
            'visibility' => $this->visibility,
            'completed' => $this->isCompleted(),
            'completed_at' => $this->completed_at?->toISOString(),
            'list_id' => $this->list_id,
            'creator' => self::person($this->creator),
            'assignee' => self::person($this->assignee),
            'created_at' => $this->created_at->toISOString(),
        ];
    }

    /** @return array{id: int, name: string, avatar_url: ?string} */
    private static function person(User $user): array
    {
        return ['id' => $user->id, 'name' => $user->name, 'avatar_url' => $user->avatar_url];
    }
}
