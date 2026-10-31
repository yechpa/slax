<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A browser that turned notifications on (Web Push). Holds no message, only where to push
 * and the keys to encrypt for. Created and removed by PushSubscriptionController; removed
 * too when the push service says it is gone (404/410), after a key rotation, on a ban and
 * with the account.
 */
class PushSubscription extends Model
{
    public const UPDATED_AT = null;

    /** Devices per account; an 11th replaces the one that went longest without a push. */
    public const MAX_PER_USER = 10;

    protected $fillable = ['user_id', 'endpoint', 'p256dh', 'auth', 'locale', 'key_id'];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return ['last_used_at' => 'datetime'];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
