<?php

namespace App\Http\Controllers;

use App\Events\ReactionChanged;
use App\Http\Resources\MessageResource;
use App\Models\Message;
use App\Models\Reaction;
use App\Rules\SingleEmoji;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;

/**
 * PUT and DELETE /messages/{id}/reactions/{emoji}: both idempotent, both answer
 * with the message (and its new reaction aggregate). Only channel members react.
 */
class ReactionController extends Controller
{
    public function store(Request $request, Message $message, string $emoji): MessageResource
    {
        return $this->change($request, $message, $emoji, function (Message $message, int $userId, string $emoji) {
            $known = $message->reactions()->where('emoji', $emoji)->exists();
            if (! $known && $message->reactions()->distinct()->count('emoji') >= Reaction::MAX_DISTINCT_PER_MESSAGE) {
                throw ValidationException::withMessages(['emoji' => 'This message already has '.Reaction::MAX_DISTINCT_PER_MESSAGE.' different emoji.']);
            }

            return DB::table('reactions')->insertOrIgnore([
                'message_id' => $message->id,
                'user_id' => $userId,
                'emoji' => $emoji,
                'created_at' => now(),
            ]) > 0;
        });
    }

    public function destroy(Request $request, Message $message, string $emoji): MessageResource
    {
        return $this->change($request, $message, $emoji, fn (Message $message, int $userId, string $emoji) => $message->reactions()
            ->where('user_id', $userId)
            ->where('emoji', $emoji)
            ->delete() > 0);
    }

    /**
     * Runs $apply on the locked message (so the distinct-emoji cap holds under
     * concurrency) and broadcasts only when it changed something.
     *
     * @param  Closure(Message, int, string): bool  $apply
     */
    private function change(Request $request, Message $message, string $emoji, Closure $apply): MessageResource
    {
        Gate::authorize('view', $message->channel);
        Gate::authorize('post', $message->channel);
        Validator::make(['emoji' => $emoji], ['emoji' => ['required', new SingleEmoji]])->validate();

        $message = DB::transaction(function () use ($request, $message, $emoji, $apply) {
            $message = Message::lockForUpdate()->findOrFail($message->id);
            abort_if($message->isDeleted(), 404);

            if ($apply($message, $request->user()->id, $emoji)) {
                ReactionChanged::dispatch($message);
            }

            return $message;
        });

        return new MessageResource($message->refreshForDisplay());
    }
}
