<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Support\Facades\DB;

class Channel extends Model
{
    use HasFactory;

    public const KIND_PUBLIC = 'public';

    public const KIND_PRIVATE = 'private';

    public const KIND_DM = 'dm';

    public const KIND_GROUP_DM = 'group_dm';

    public const ROLE_MEMBER = 'member';

    public const ROLE_OWNER = 'owner';

    protected $fillable = ['workspace_id', 'kind', 'name', 'topic', 'dm_key', 'created_by'];

    /** @return BelongsTo<Workspace, $this> */
    public function workspace(): BelongsTo
    {
        return $this->belongsTo(Workspace::class);
    }

    /** @return BelongsToMany<User, $this> */
    public function members(): BelongsToMany
    {
        return $this->belongsToMany(User::class, 'channel_members')
            ->withPivot('role', 'last_read_message_id')
            ->withTimestamps();
    }

    public function isPublic(): bool
    {
        return $this->kind === self::KIND_PUBLIC;
    }

    /** Public and private channels are named, managed rooms; DMs are handled elsewhere. */
    public function isRoom(): bool
    {
        return in_array($this->kind, [self::KIND_PUBLIC, self::KIND_PRIVATE], true);
    }

    /** One-to-one and group conversations: anonymous, membership fixed at creation. */
    public function isDirect(): bool
    {
        return in_array($this->kind, [self::KIND_DM, self::KIND_GROUP_DM], true);
    }

    public function roleOf(User $user): ?string
    {
        return $this->members()->whereKey($user->id)->first()?->pivot->role;
    }

    public function hasMember(User $user): bool
    {
        return $this->members()->whereKey($user->id)->exists();
    }

    /**
     * Idempotent: an existing membership (and its role) is left untouched.
     * Returns whether a new membership was created.
     */
    public function addMember(User $user, string $role = self::ROLE_MEMBER): bool
    {
        $now = now();

        return DB::table('channel_members')->insertOrIgnore([
            'channel_id' => $this->id,
            'user_id' => $user->id,
            'role' => $role,
            'created_at' => $now,
            'updated_at' => $now,
        ]) > 0;
    }
}
