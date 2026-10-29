<?php

namespace App\Models;

use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;

class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasFactory;

    public const LOCALES = ['en', 'he', 'fr'];

    public const THEMES = ['console', 'listing'];

    /**
     * Privileged columns (is_admin, banned_at, google_sub) are deliberately not
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
}
