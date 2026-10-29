<?php

namespace App\Http\Controllers;

use App\Events\MemberRemoved;
use App\Http\Resources\ChannelResource;
use App\Models\Channel;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;

class ChannelController extends Controller
{
    /** Public channels plus the private ones the caller belongs to. */
    public function index(Request $request): AnonymousResourceCollection
    {
        $user = $request->user();

        $channels = Channel::where('workspace_id', Workspace::default()->id)
            ->where(fn ($query) => $query
                ->where('kind', Channel::KIND_PUBLIC)
                ->orWhere(fn ($query) => $query
                    ->where('kind', Channel::KIND_PRIVATE)
                    ->whereHas('members', fn ($members) => $members->whereKey($user->id))))
            ->withExists(['members' => fn ($members) => $members->whereKey($user->id)])
            ->orderBy('name')
            ->get();

        return ChannelResource::collection($channels);
    }

    public function show(Request $request, Channel $channel): ChannelResource
    {
        Gate::authorize('view', $channel);

        return ChannelResource::withMembership($channel, $channel->hasMember($request->user()));
    }

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
        ]);

        try {
            $channel = DB::transaction(function () use ($request, $workspace, $data) {
                $channel = Channel::create($data + ['workspace_id' => $workspace->id, 'created_by' => $request->user()->id]);
                $channel->addMember($request->user(), Channel::ROLE_OWNER);

                return $channel;
            });
        } catch (UniqueConstraintViolationException) {
            // Lost a race against another creator of the same name.
            throw ValidationException::withMessages(['name' => __('validation.unique', ['attribute' => 'name'])]);
        }

        return ChannelResource::withMembership($channel, true)->response()->setStatusCode(201);
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

        $data = $request->validate(['user_id' => ['required', 'integer', 'exists:users,id']]);

        $user = User::findOrFail($data['user_id']);
        $created = $channel->addMember($user);

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
