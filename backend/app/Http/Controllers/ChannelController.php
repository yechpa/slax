<?php

namespace App\Http\Controllers;

use App\Events\ChannelAdded;
use App\Events\MemberRemoved;
use App\Http\Resources\ChannelResource;
use App\Models\Channel;
use App\Models\User;
use App\Models\Workspace;
use App\Services\ReadState;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;

class ChannelController extends Controller
{
    /**
     * Public channels plus the private channels and conversations the caller belongs to,
     * with the caller's read state. A fixed number of queries, whatever the number of channels.
     */
    public function index(Request $request): JsonResponse
    {
        $user = $request->user();

        $channels = Channel::where('workspace_id', Workspace::default()->id)
            ->where(fn ($query) => $query
                ->where('kind', Channel::KIND_PUBLIC)
                ->orWhere(fn ($query) => $query
                    ->whereIn('kind', [Channel::KIND_PRIVATE, Channel::KIND_DM, Channel::KIND_GROUP_DM])
                    ->whereHas('members', fn ($members) => $members->whereKey($user->id))))
            // A one-to-one conversation with a banned person is not listed any more.
            ->where(fn ($query) => $query
                ->where('kind', '!=', Channel::KIND_DM)
                ->orWhereDoesntHave('members', fn ($members) => $members->whereNotNull('users.banned_at')))
            ->withExists(['members' => fn ($members) => $members->whereKey($user->id)])
            // Banned accounts are left out of every member list and count (ChannelResource).
            ->withCount(['members' => fn ($members) => $members->whereNull('users.banned_at')])
            ->orderBy('name')
            ->orderBy('id')
            ->get();

        $channels->filter->isDirect()->load(['members' => fn ($members) => $members->orderBy('users.id')]);
        $readStates = ReadState::forChannels($user, $channels->modelKeys());

        return response()->json($channels->map(
            fn (Channel $channel) => (new ChannelResource($channel))->withReadState($readStates[$channel->id])->resolve($request),
        ));
    }

    /**
     * POST /channels/{id}/read {message_id}: the caller has seen the timeline up to this
     * top-level message. Members only (404 otherwise, public channels included); the pointer
     * never moves back.
     */
    public function read(Request $request, Channel $channel): Response
    {
        abort_unless($channel->hasMember($request->user()), 404);

        $data = $request->validate([
            'message_id' => [
                'bail', 'required', 'integer', 'min:1',
                Rule::exists('messages', 'id')->where('channel_id', $channel->id)->whereNull('parent_id'),
            ],
        ]);

        ReadState::markRead($request->user(), $channel, (int) $data['message_id']);

        return response()->noContent();
    }

    public function show(Request $request, Channel $channel): ChannelResource
    {
        Gate::authorize('view', $channel);

        if ($channel->isDirect()) {
            $channel->load(['members' => fn ($members) => $members->orderBy('users.id')]);
        }

        return ChannelResource::withMembership($channel, $channel->hasMember($request->user()));
    }

    /**
     * The validation message of a name already in use, and only of that refusal: the SPA
     * recognizes it and says "taken" in the reader's language (other refusals are shown as sent).
     */
    public const NAME_TAKEN = 'The name has already been taken.';

    public function store(Request $request): JsonResponse
    {
        $workspace = Workspace::default();
        $data = $request->validate([
            'name' => [
                'required', 'string', 'regex:/^[a-z0-9][a-z0-9-]{0,39}$/',
                Rule::unique('channels', 'name')->where('workspace_id', $workspace->id),
            ],
            'kind' => ['required', Rule::in([Channel::KIND_PUBLIC, Channel::KIND_PRIVATE])],
            'topic' => ['nullable', 'string', 'max:250'],
        ], ['name.unique' => self::NAME_TAKEN]);

        try {
            $channel = DB::transaction(function () use ($request, $workspace, $data) {
                $channel = Channel::create($data + ['workspace_id' => $workspace->id, 'created_by' => $request->user()->id]);
                $channel->addMember($request->user(), Channel::ROLE_OWNER);

                return $channel;
            });
        } catch (UniqueConstraintViolationException) {
            // Lost a race against another creator of the same name.
            throw ValidationException::withMessages(['name' => self::NAME_TAKEN]);
        }

        return ChannelResource::withMembership($channel, true)->response()->setStatusCode(201);
    }

    public const MAX_MEMBERS_LISTED = 200;

    /**
     * GET /channels/{id}/members: who is in a channel the caller may see (any public channel,
     * or one they belong to; 404 otherwise). Owners first, then by name; at most 200.
     * Only the public profile, never an e-mail address; banned accounts are left out.
     */
    public function members(Channel $channel): JsonResponse
    {
        Gate::authorize('view', $channel);

        $members = $channel->members()
            ->whereNull('users.banned_at')
            ->orderByRaw("CASE WHEN channel_members.role = 'owner' THEN 0 ELSE 1 END")
            ->orderByRaw('lower(users.name)')
            ->orderBy('users.name')
            ->orderBy('users.id')
            ->limit(self::MAX_MEMBERS_LISTED)
            ->get(['users.id', 'users.name', 'users.avatar_url']);

        return response()->json($members->map(fn (User $member) => [
            'id' => $member->id,
            'name' => $member->name,
            'avatar_url' => $member->avatar_url,
            'role' => $member->pivot->role,
        ]));
    }

    public function join(Request $request, Channel $channel): ChannelResource
    {
        Gate::authorize('view', $channel);
        Gate::authorize('join', $channel);

        $channel->addMember($request->user());

        return ChannelResource::withMembership($channel, true);
    }

    public function leave(Request $request, Channel $channel): Response
    {
        Gate::authorize('view', $channel);
        Gate::authorize('leave', $channel);

        return $this->removeMember($channel, $request->user());
    }

    public function addMember(Request $request, Channel $channel): JsonResponse
    {
        Gate::authorize('view', $channel);
        Gate::authorize('manage', $channel);

        // Banned accounts cannot be added (same answer as an unknown id).
        $data = $request->validate(['user_id' => ['required', 'integer', Rule::exists('users', 'id')->whereNull('banned_at')]]);

        $user = User::findOrFail($data['user_id']);
        $created = DB::transaction(function () use ($channel, $user) {
            $created = $channel->addMember($user);
            // Told at once (after the commit), only when this really made them a member.
            if ($created) {
                ChannelAdded::dispatch($channel->id, $user->id);
            }

            return $created;
        });

        return response()->json([
            'channel_id' => $channel->id,
            'user_id' => $user->id,
            'role' => $channel->roleOf($user),
        ], $created ? 201 : 200);
    }

    public function removeMemberRoute(Request $request, Channel $channel, User $user): Response
    {
        Gate::authorize('view', $channel);
        Gate::authorize($user->is($request->user()) ? 'leave' : 'manage', $channel);

        return $this->removeMember($channel, $user);
    }

    /** 204 when the user is no longer a member (also when they never were); 422 for the last owner. */
    private function removeMember(Channel $channel, User $user): Response
    {
        $removed = DB::transaction(function () use ($channel, $user) {
            // Lock the owners so two owners cannot leave at once and orphan the channel.
            $owners = $channel->members()->wherePivot('role', Channel::ROLE_OWNER)->lockForUpdate()->pluck('users.id');

            if ($owners->all() === [$user->id]) {
                return null;
            }

            return $channel->members()->detach($user->id) > 0;
        });

        if ($removed === null) {
            return response()->json(['error' => 'sole_owner'], 422);
        }
        if ($removed) {
            MemberRemoved::dispatch($channel, $user);
        }

        return response()->noContent();
    }
}
