<?php

namespace App\Models;

use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Foundation\Auth\User as Authenticatable;

class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasFactory;

    public const LOCALES = ['en', 'he', 'fr'];

    public const THEMES = ['console', 'listing'];

    /** Administrators, and accounts that predate demo accounts: never expire. */
    public const ACCOUNT_MEMBER = 'member';

    /** Signed up by a visitor of the public demo: deleted after a week without activity. */
    public const ACCOUNT_DEMO = 'demo';

    /** The demo's fictional people (DemoSeeder): they never sign in. */
    public const ACCOUNT_SEED = 'seed';

    /** last_seen_at is written at most this often (it only feeds the demo expiry). */
    public const LAST_SEEN_PRECISION_MINUTES = 15;

    /**
     * Privileged columns (is_admin, banned_at, google_sub, account_type) are deliberately not
     * mass assignable: only trusted code sets them explicitly.
     *
     * @var list<string>
     */
    protected $fillable = [
        'email',
        'name',
        'avatar_url',
        'locale',
        'theme',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'is_admin' => 'boolean',
            'banned_at' => 'datetime',
            'last_seen_at' => 'datetime',
        ];
    }

    public function isBanned(): bool
    {
        return $this->banned_at !== null;
    }

    /** Recorded on sign-in and by presence heartbeats, at most every 15 minutes. */
    public function touchLastSeen(): void
    {
        if ($this->last_seen_at === null || $this->last_seen_at->lt(now()->subMinutes(self::LAST_SEEN_PRECISION_MINUTES))) {
            $this->forceFill(['last_seen_at' => now()])->saveQuietly();
        }
    }

    /** @return BelongsToMany<Channel, $this> */
    public function channels(): BelongsToMany
    {
        return $this->belongsToMany(Channel::class, 'channel_members')
            ->withPivot('role', 'last_read_message_id')
            ->withTimestamps();
    }
}
