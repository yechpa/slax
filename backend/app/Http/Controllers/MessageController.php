<?php

namespace App\Http\Controllers;

use App\Events\MessageCreated;
use App\Events\MessageDeleted;
use App\Events\MessageUpdated;
use App\Http\Resources\MessageResource;
use App\Models\Channel;
use App\Models\Message;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Channel timelines, threads, posting, editing and (soft) deleting.
 * Reading needs ChannelPolicy::view (404 otherwise), posting ChannelPolicy::post
 * (403 for non-members), editing and deleting authorship (MessagePolicy).
 */
class MessageController extends Controller
{
    public const DEFAULT_PAGE = 50;

    public const MAX_PAGE = 100;

    /** Top-level messages of the channel; replies are listed per thread. */
    public function index(Request $request, Channel $channel): JsonResponse
    {
        Gate::authorize('view', $channel);

        return $this->page($request, Message::where('channel_id', $channel->id)->whereNull('parent_id'));
    }

    public function replies(Request $request, Message $message): JsonResponse
    {
        Gate::authorize('view', $message->channel);
        abort_if($message->isReply(), 404);

        $page = $this->page($request, Message::where('parent_id', $message->id));

        return $page->setData(['parent' => (new MessageResource($message->refreshForDisplay()))->resolve($request)] + $page->getData(true));
    }

    public function store(Request $request, Channel $channel): JsonResponse
    {
        Gate::authorize('view', $channel);
        Gate::authorize('post', $channel);

        $this->trimBody($request);
        $data = $request->validate([
            'body' => $this->bodyRules(),
            'client_id' => ['required', 'uuid'],
            'parent_id' => ['nullable', 'integer'],
        ]);
        $body = $data['body'];
        $user = $request->user();
        $clientId = Str::lower($data['client_id']);
        $parentId = $data['parent_id'] ?? null;

        if ($replay = $this->replay($user, $clientId, $channel)) {
            return $replay;
        }

        // One level of threads: the parent is a top-level message of this channel (deleted or not).
        if ($parentId !== null && ! Message::whereKey($parentId)->where('channel_id', $channel->id)->whereNull('parent_id')->exists()) {
            throw ValidationException::withMessages(['parent_id' => 'The parent must be a top-level message of this channel.']);
        }

        $message = DB::transaction(function () use ($channel, $user, $body, $clientId, $parentId): ?Message {
            // Posts to one channel commit one at a time, so ids become visible in increasing
            // order and an `after` cursor cannot skip a message that committed late.
            Channel::whereKey($channel->id)->lockForUpdate()->first();
            // Membership again, under the lock: a removal committed since the check above wins.
            Gate::authorize('post', $channel);

            // A concurrent request with the same client_id may have inserted it since replay():
            // no row then (and no aborted transaction), and the replay below answers.
            $id = DB::scalar(
                'INSERT INTO messages (channel_id, user_id, parent_id, body, client_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (user_id, client_id) DO NOTHING
                 RETURNING id',
                [$channel->id, $user->id, $parentId, $body, $clientId, $now = now(), $now],
                useReadPdo: false,
            );
            if ($id === null) {
                return null;
            }

            $message = Message::findOrFail($id);
            MessageCreated::dispatch($message);

            return $message;
        });

        if ($message === null) {
            return $this->replay($user, $clientId, $channel) ?? abort(409);
        }

        return (new MessageResource($message->refreshForDisplay()))->response()->setStatusCode(201);
    }

    /** Author only, and only while still allowed to post there (deleting stays possible after leaving). */
    public function update(Request $request, Message $message): MessageResource
    {
        Gate::authorize('view', $message->channel);
        Gate::authorize('post', $message->channel);
        Gate::authorize('update', $message);

        $this->trimBody($request);
        $body = $request->validate(['body' => $this->bodyRules()])['body'];

        $message = DB::transaction(function () use ($message, $body) {
            $message = Message::lockForUpdate()->findOrFail($message->id);
            abort_if($message->isDeleted(), 404);

            if ($message->body !== $body) {
                $message->forceFill(['body' => $body, 'edited_at' => now()])->save();
                MessageUpdated::dispatch($message);
            }

            return $message;
        });

        return new MessageResource($message->refreshForDisplay());
    }

    /** Soft delete; idempotent. Replies stay, the message becomes a tombstone. */
    public function destroy(Message $message): MessageResource
    {
        Gate::authorize('view', $message->channel);
        Gate::authorize('delete', $message);

        $message = DB::transaction(function () use ($message) {
            $message = Message::lockForUpdate()->findOrFail($message->id);

            if (! $message->isDeleted()) {
                $message->forceFill(['deleted_at' => now()])->save();
                MessageDeleted::dispatch($message);
            }

            return $message;
        });

        return new MessageResource($message->refreshForDisplay());
    }

    /**
     * The body, trimmed of plain whitespace only: TrimStrings skips `body` (bootstrap/app.php)
     * because it would also strip the bidi marks (RLM, LRM, ALM) a Hebrew message may start
     * or end with.
     */
    private function trimBody(Request $request): void
    {
        if (is_string($body = $request->input('body'))) {
            $request->merge(['body' => trim($body, " \t\n\r\v\f")]);
        }
    }

    /** @return list<string> */
    private function bodyRules(): array
    {
        // `max` counts characters, not bytes.
        return ['required', 'string', 'max:'.Message::MAX_BODY];
    }

    /** 200 with the message this user already sent under this client_id, if any. */
    private function replay(User $user, string $clientId, Channel $channel): ?JsonResponse
    {
        $existing = Message::where('user_id', $user->id)->where('client_id', $clientId)->first();

        if ($existing === null) {
            return null;
        }
        if ($existing->channel_id !== $channel->id) {
            throw ValidationException::withMessages(['client_id' => 'This client_id was already used for another message.']);
        }

        return (new MessageResource($existing->refreshForDisplay()))->response()->setStatusCode(200);
    }

    /**
     * Cursor pagination by id, each page in ascending order.
     * No cursor: the latest messages. `before`: the ones just older. `after`: the ones
     * just newer (catching up after a disconnection). `has_more` tells whether the
     * same direction has more.
     *
     * @param  Builder<Message>  $query
     */
    private function page(Request $request, Builder $query): JsonResponse
    {
        $data = $request->validate([
            'before' => ['nullable', 'integer', 'min:1', 'prohibits:after'],
            'after' => ['nullable', 'integer', 'min:0'],
            'limit' => ['nullable', 'integer', 'between:1,'.self::MAX_PAGE],
        ]);
        $limit = (int) ($data['limit'] ?? self::DEFAULT_PAGE);
        $query->forDisplay()->limit($limit + 1);

        if (isset($data['after'])) {
            $messages = $query->where('id', '>', $data['after'])->orderBy('id')->get();
        } else {
            if (isset($data['before'])) {
                $query->where('id', '<', $data['before']);
            }
            $messages = $query->orderByDesc('id')->get();
        }

        $hasMore = $messages->count() > $limit;
        $messages = $messages->take($limit)->sortBy('id')->values();

        return response()->json([
            'data' => MessageResource::collection($messages)->resolve($request),
            'has_more' => $hasMore,
        ]);
    }
}
