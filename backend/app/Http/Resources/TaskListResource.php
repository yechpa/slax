<?php

namespace App\Http\Resources;

use App\Models\TaskList;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * `open_count` is the owner's uncompleted tasks in the list: load it with withCount / loadCount first (TaskListController).
 *
 * @mixin TaskList
 */
class TaskListResource extends JsonResource
{
    /**
     * @return array{id: int, name: string, position: int, open_count: int}
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'position' => $this->position,
            'open_count' => (int) $this->open_count,
        ];
    }
}
