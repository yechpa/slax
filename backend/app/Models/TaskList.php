<?php

namespace App\Models;

use Database\Factories\TaskListFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** One of a person's own task lists. Lists are never shared: only the owner sees them. */
class TaskList extends Model
{
    /** @use HasFactory<TaskListFactory> */
    use HasFactory;

    /** The owner is set by the service from the caller, never mass assigned. */
    protected $fillable = ['workspace_id', 'name', 'position'];

    /** @return BelongsTo<User, $this> */
    public function owner(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }

    /** @return HasMany<Task, $this> */
    public function tasks(): HasMany
    {
        return $this->hasMany(Task::class, 'list_id');
    }
}
