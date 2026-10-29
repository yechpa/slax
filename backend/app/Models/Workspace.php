<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Workspace extends Model
{
    use HasFactory;

    public const DEFAULT_SLUG = 'slax';

    protected $fillable = ['name', 'slug'];

    /** Slax v1 runs a single workspace; this is it (created by DefaultWorkspaceSeeder). */
    public static function default(): self
    {
        return static::where('slug', self::DEFAULT_SLUG)->firstOrFail();
    }

    /** @return HasMany<Channel, $this> */
    public function channels(): HasMany
    {
        return $this->hasMany(Channel::class);
    }
}
