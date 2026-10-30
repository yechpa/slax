<?php

namespace App\Models;

use Database\Factories\FileFactory;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Str;

/**
 * An uploaded file: approved by the scanner, stored in the `s3` disk under a random key,
 * uploaded for one channel and attached to at most one message of it.
 */
class File extends Model
{
    /** @use HasFactory<FileFactory> */
    use HasFactory;

    public const UPDATED_AT = null;

    public const MAX_BYTES = 10 * 1024 * 1024;

    /** Per account, counting every file the account still has. */
    public const ACCOUNT_QUOTA_BYTES = 100 * 1024 * 1024;

    /** An upload must be attached to a message within this delay, or files:prune-orphans removes it. */
    public const UNATTACHED_TTL_HOURS = 24;

    public const STATUS_PENDING = 'pending';

    public const STATUS_CLEAN = 'clean';

    /** Accepted (detected) types and the extensions a file of each type may carry, canonical first. */
    public const EXTENSIONS = [
        'image/png' => ['png'],
        'image/jpeg' => ['jpg', 'jpeg'],
        'image/gif' => ['gif'],
        'image/webp' => ['webp'],
        'application/pdf' => ['pdf'],
        'text/plain' => ['txt'],
        'application/zip' => ['zip'],
    ];

    protected $fillable = ['user_id', 'channel_id', 'message_id', 'storage_key', 'display_name', 'mime', 'size', 'sha256', 'scan_status'];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return ['size' => 'integer'];
    }

    public static function newStorageKey(): string
    {
        return 'files/'.now()->format('Y/m').'/'.Str::uuid()->toString();
    }

    /** Bytes the account currently holds. */
    public static function usedBytes(User $user): int
    {
        return (int) static::where('user_id', $user->id)->sum('size');
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return BelongsTo<Channel, $this> */
    public function channel(): BelongsTo
    {
        return $this->belongsTo(Channel::class);
    }

    /** @return BelongsTo<Message, $this> */
    public function message(): BelongsTo
    {
        return $this->belongsTo(Message::class);
    }

    public function isAvailable(): bool
    {
        return $this->scan_status === self::STATUS_CLEAN;
    }

    /** image, pdf or other: images and PDFs are shown inline, everything else is downloaded. */
    public function kind(): string
    {
        return match (true) {
            str_starts_with($this->mime, 'image/') => 'image',
            $this->mime === 'application/pdf' => 'pdf',
            default => 'other',
        };
    }

    /** RFC 6266 / RFC 5987: the display name survives any character, quotes and semicolons included. */
    public function contentDisposition(): string
    {
        $type = $this->kind() === 'other' ? 'attachment' : 'inline';

        return $type."; filename*=UTF-8''".rawurlencode($this->display_name);
    }

    /**
     * Files $user may attach to a new message in $channel: their own, uploaded there, stored,
     * not attached yet and recent enough not to be pruned meanwhile.
     *
     * @param  Builder<File>  $query
     */
    public function scopeAttachableBy(Builder $query, User $user, Channel $channel): void
    {
        $query->where('user_id', $user->id)
            ->where('channel_id', $channel->id)
            ->whereNull('message_id')
            ->where('scan_status', self::STATUS_CLEAN)
            ->where('created_at', '>', now()->subHours(self::UNATTACHED_TTL_HOURS));
    }
}
