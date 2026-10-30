<?php

namespace App\Http\Controllers;

use App\Models\Channel;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

/**
 * The people directory, for picking someone (a new conversation, a member to add).
 * Only what everybody in the workspace already sees next to a message: id, name, avatar.
 * Never the e-mail address, and never banned accounts.
 */
class UserController extends Controller
{
    public const MAX_RESULTS = 20;

    public const MAX_QUERY = 50;

    /**
     * GET /users?q=&limit=&not_in_channel=: non-banned users (not the caller) whose name contains
     * `q`, case-insensitively. `not_in_channel` leaves out the members of that channel (adding
     * people to it), whatever their number; a channel the caller may not see is a 404, like
     * one that does not exist.
     */
    public function index(Request $request): JsonResponse
    {
        if (is_string($q = $request->query('q'))) {
            $request->merge(['q' => trim($q)]);
        }
        $data = $request->validate([
            'q' => ['required', 'string', 'min:1', 'max:'.self::MAX_QUERY],
            'limit' => ['sometimes', 'integer', 'between:1,'.self::MAX_RESULTS],
            'not_in_channel' => ['sometimes', 'integer', 'min:1'],
        ]);

        $channel = null;
        if (isset($data['not_in_channel'])) {
            $channel = Channel::findOrFail((int) $data['not_in_channel']);
            Gate::authorize('view', $channel);
        }

        // LIKE wildcards in the query are literal characters.
        $pattern = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $data['q']).'%';

        $users = User::query()
            ->whereNull('banned_at')
            ->whereKeyNot($request->user()->id)
            ->when($channel, fn ($users) => $users->whereDoesntHave('channels', fn ($channels) => $channels->whereKey($channel->id)))
            ->whereRaw("name ILIKE ? ESCAPE '\\'", [$pattern])
            // Case-insensitive, whatever the database collation: "amy" before "Bob".
            ->orderByRaw('lower(name)')
            ->orderBy('name')
            ->orderBy('id')
            ->limit((int) ($data['limit'] ?? self::MAX_RESULTS))
            ->get(['id', 'name', 'avatar_url']);

        return response()->json($users->map(fn (User $user) => [
            'id' => $user->id,
            'name' => $user->name,
            'avatar_url' => $user->avatar_url,
        ]));
    }
}
