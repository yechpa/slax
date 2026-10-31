<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** One user's emoji on one message (unique per message, user and emoji). */
class Reaction extends Model
{
    public const UPDATED_AT = null;

    /** Distinct emoji a single message may carry. */
    public const MAX_DISTINCT_PER_MESSAGE = 20;

    protected $fillable = ['message_id', 'user_id', 'emoji'];

    /** @return BelongsTo<Message, $this> */
    public function message(): BelongsTo
    {
        return $this->belongsTo(Message::class);
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
