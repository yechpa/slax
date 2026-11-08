<?php

namespace App\Models;

use Database\Factories\TaskFactory;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A task: created by one person, held by another (or themselves), public or private.
 * Parties (creator, assignee, list, completion) are set by the services, never mass assigned.
 */
class Task extends Model
{
    /** @use HasFactory<TaskFactory> */
    use HasFactory;

    public const PUBLIC = 'public';

    public const PRIVATE = 'private';

    protected $fillable = ['workspace_id', 'title', 'visibility', 'position'];

    /**
     * Who held the task before TaskService::updateTask or returnToAuthor handed it on (null otherwise). A plain property on
     * the returned instance, not a column, so the notifications can reach the former assignee.
     */
    public ?int $previousAssigneeId = null;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return ['completed_at' => 'datetime'];
    }

    /** @return BelongsTo<User, $this> */
    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'creator_id');
    }

    /** @return BelongsTo<User, $this> */
    public function assignee(): BelongsTo
    {
        return $this->belongsTo(User::class, 'assignee_id');
    }

    /** @return BelongsTo<TaskList, $this> */
    public function list(): BelongsTo
    {
        return $this->belongsTo(TaskList::class, 'list_id');
    }

    public function isCompleted(): bool
    {
        return $this->completed_at !== null;
    }

    /**
     * Public tasks, plus the ones the viewer created or holds. No special case for administrators.
     *
     * @param  Builder<Task>  $query
     * @return Builder<Task>
     */
    public function scopeVisibleTo(Builder $query, User $viewer): Builder
    {
        return $query->where(fn (Builder $q) => $q
            ->where('visibility', self::PUBLIC)
            ->orWhere('creator_id', $viewer->id)
            ->orWhere('assignee_id', $viewer->id));
    }

    public function isVisibleTo(User $viewer): bool
    {
        return $this->visibility === self::PUBLIC
            || $this->creator_id === $viewer->id
            || $this->assignee_id === $viewer->id;
    }
}
