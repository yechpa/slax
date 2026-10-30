<?php

namespace App\Http\Controllers;

use App\Http\Resources\MessageResource;
use App\Models\AuditLog;
use App\Models\Channel;
use App\Models\File;
use App\Models\Message;
use App\Models\User;
use App\Services\Moderation;
use App\Services\ServiceStatus;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * /api/v1/admin/*: moderation, the audit log and the status of the services.
 *
 * Every route is behind the `admin` gate (routes/api.php; non-administrators get 403 before
 * any lookup, so nothing leaks) and writes are rate limited. Records are looked up by id
 * inside each action for the same reason. Answers carry ids and display names, never an
 * e-mail address or a message body.
 */
class AdminController extends Controller
{
    public const AUDIT_PAGE = 50;

    public const MAX_AUDIT_PAGE = 100;

    public const MAX_BANNED_LISTED = 200;

    public function __construct(private readonly Moderation $moderation) {}

    /** POST /admin/users/{id}/ban {banned?: bool = true}: idempotent; false lifts the ban. */
    public function ban(Request $request, int $id): JsonResponse
    {
        $data = $request->validate(['banned' => ['sometimes', 'boolean']]);
        $user = User::findOrFail($id);

        // An ADMIN_EMAILS address is an administrator at its next sign-in, flag or not.
        if ($user->isAdministrator()) {
            return response()->json(['error' => 'cannot_ban_admin'], 422);
        }

        ($data['banned'] ?? true) ? $this->moderation->ban($user) : $this->moderation->unban($user);

        return response()->json(self::person($user));
    }

    /** GET /admin/users/banned: who is banned, most recent first (to lift a ban). */
    public function bannedUsers(): JsonResponse
    {
        $users = User::whereNotNull('banned_at')
            ->orderByDesc('banned_at')
            ->orderByDesc('id')
            ->limit(self::MAX_BANNED_LISTED)
            ->get(['id', 'name', 'avatar_url', 'banned_at']);

        return response()->json(['data' => $users->map(self::person(...))->all()]);
    }

    /**
     * DELETE /admin/messages/{id}: a tombstone for everyone, files deleted (objects first).
     * 503 `storage_unavailable` when a file could not be deleted: the message is a tombstone
     * already and calling again retries the files.
     */
    public function destroyMessage(int $id): JsonResponse
    {
        $message = Message::findOrFail($id);

        if (! $this->moderation->deleteMessage($message)) {
            return response()->json(['error' => 'storage_unavailable'], 503);
        }

        return (new MessageResource($message->refreshForDisplay()))->response();
    }

    /** DELETE /admin/files/{id}: 204, or 503 `storage_unavailable` with nothing changed. */
    public function destroyFile(int $id): Response|JsonResponse
    {
        $file = File::findOrFail($id);

        if (! $this->moderation->deleteFile($file)) {
            return response()->json(['error' => 'storage_unavailable'], 503);
        }

        return response()->noContent();
    }

    /**
     * POST /admin/channels/{id}/lock {locked?: bool = true}: idempotent; false unlocks.
     * Public and private channels (any of them, membership aside); not conversations.
     */
    public function lock(Request $request, int $id): JsonResponse
    {
        $data = $request->validate(['locked' => ['sometimes', 'boolean']]);
        $channel = Channel::whereKey($id)->whereIn('kind', [Channel::KIND_PUBLIC, Channel::KIND_PRIVATE])->firstOrFail();

        $this->moderation->setLocked($channel, (bool) ($data['locked'] ?? true));

        return response()->json(['id' => $channel->id, 'name' => $channel->name, 'locked' => $channel->isLocked()]);
    }

    /** GET /admin/audit?page=&per_page=: newest first. */
    public function audit(Request $request): JsonResponse
    {
        $data = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'per_page' => ['sometimes', 'integer', 'between:1,'.self::MAX_AUDIT_PAGE],
        ]);
        $page = (int) ($data['page'] ?? 1);
        $perPage = (int) ($data['per_page'] ?? self::AUDIT_PAGE);

        $entries = AuditLog::with('actor:id,name')
            ->orderByDesc('id')
            ->forPage($page, $perPage)
            ->limit($perPage + 1)
            ->get();
        $hasMore = $entries->count() > $perPage;
        $entries = $entries->take($perPage);

        $labels = [
            'user' => User::whereKey($entries->where('target_type', 'user')->pluck('target_id'))->pluck('name', 'id'),
            'channel' => Channel::whereKey($entries->where('target_type', 'channel')->pluck('target_id'))->pluck('name', 'id'),
        ];

        return response()->json([
            'data' => $entries->map(fn (AuditLog $entry) => [
                'id' => $entry->id,
                'action' => $entry->action,
                'created_at' => $entry->created_at?->toISOString(),
                'ip' => $entry->ip,
                'actor' => $entry->actor ? ['id' => $entry->actor->id, 'name' => $entry->actor->name] : null,
                'target' => $entry->target_type === null ? null : [
                    'type' => $entry->target_type,
                    'id' => $entry->target_id,
                    // A display name (people, channels); never content.
                    'label' => $labels[$entry->target_type][$entry->target_id] ?? null,
                ],
            ])->values()->all(),
            'page' => $page,
            'per_page' => $perPage,
            'has_more' => $hasMore,
        ]);
    }

    /** GET /admin/status: each service ok or degraded, with its probe's latency. */
    public function status(ServiceStatus $status): JsonResponse
    {
        return response()->json([
            'environment' => (string) config('slax.alerts.env_label', 'Dev'),
            'checked_at' => now()->toISOString(),
            'services' => $status->check(),
        ]);
    }

    /** @return array{id: int, name: string, avatar_url: ?string, banned: bool, banned_at: ?string} */
    private static function person(User $user): array
    {
        return [
            'id' => $user->id,
            'name' => $user->name,
            'avatar_url' => $user->avatar_url,
            'banned' => $user->isBanned(),
            'banned_at' => $user->banned_at?->toISOString(),
        ];
    }
}
