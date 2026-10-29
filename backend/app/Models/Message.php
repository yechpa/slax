<?php

namespace App\Models;

use Database\Factories\MessageFactory;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A channel message, or a reply when parent_id is set (threads are one level deep).
 * Deletion is soft (deleted_at) and handled by hand rather than with SoftDeletes:
 * deleted messages stay listed, as tombstones.
 */
class Message extends Model
{
    /** @use HasFactory<MessageFactory> */
    use HasFactory;

    public const MAX_BODY = 4000;

    protected $fillable = ['channel_id', 'user_id', 'parent_id', 'body', 'client_id'];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'edited_at' => 'datetime',
            'deleted_at' => 'datetime',
            // Thread summary aggregate (see scopeForDisplay).
            'last_reply_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<Channel, $this> */
    public function channel(): BelongsTo
    {
        return $this->belongsTo(Channel::class);
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return BelongsTo<Message, $this> */
    public function parent(): BelongsTo
    {
        return $this->belongsTo(Message::class, 'parent_id');
    }

    /** @return HasMany<Message, $this> */
    public function replies(): HasMany
    {
        return $this->hasMany(Message::class, 'parent_id');
    }

    /** @return HasMany<Reaction, $this> */
    public function reactions(): HasMany
    {
        return $this->hasMany(Reaction::class);
    }

    public function isDeleted(): bool
    {
        return $this->deleted_at !== null;
    }

    public function isReply(): bool
    {
        return $this->parent_id !== null;
    }

    /**
     * Everything MessageResource renders: author, reactions and the thread summary
     * (live replies only).
     *
     * @param  Builder<Message>  $query
     */
    public function scopeForDisplay(Builder $query): void
    {
        $live = fn ($replies) => $replies->whereNull('deleted_at');

        $query->with(['user:id,name,avatar_url', 'reactions'])
            ->withCount(['replies as reply_count' => $live])
            ->withMax(['replies as last_reply_at' => $live], 'created_at');
    }

    /** Reloads this message with everything MessageResource renders. */
    public function refreshForDisplay(): static
    {
        return static::query()->forDisplay()->findOrFail($this->id);
    }
}
