<?php

use App\Events\MessageCreated;
use App\Events\MessageDeleted;
use App\Events\MessageUpdated;
use App\Models\Channel;
use App\Models\Message;
use App\Models\User;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

function sendMessage(User $user, Channel $channel, array $data = []): TestResponse
{
    return asUser($user)->postJson("/api/v1/channels/{$channel->id}/messages", $data + [
        'body' => 'hello',
        'client_id' => (string) Str::uuid(),
    ]);
}

/** A top-level message (or a reply, with $parent) written straight to the database. */
function message(User $user, Channel $channel, string $body = 'hi', ?Message $parent = null): Message
{
    return Message::factory()->create([
        'channel_id' => $channel->id,
        'user_id' => $user->id,
        'parent_id' => $parent?->id,
        'body' => $body,
    ]);
}

test('post_is_idempotent_on_client_id', function () {
    Event::fake([MessageCreated::class]);
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $clientId = (string) Str::uuid();

    $first = sendMessage($user, $channel, ['body' => 'once', 'client_id' => $clientId])
        ->assertCreated()
        ->assertJson([
            'channel_id' => $channel->id,
            'parent_id' => null,
            'client_id' => $clientId,
            'body' => 'once',
            'deleted' => false,
            'edited_at' => null,
            'reply_count' => 0,
            'last_reply_at' => null,
            'reactions' => [],
            'user' => ['id' => $user->id, 'name' => $user->name],
        ]);

    // A retry (lost response, double click...) returns the same message with 200, even with another body.
    sendMessage($user, $channel, ['body' => 'twice', 'client_id' => $clientId])
        ->assertOk()
        ->assertJson(['id' => $first->json('id'), 'body' => 'once']);

    expect(Message::count())->toBe(1);
    Event::assertDispatchedTimes(MessageCreated::class, 1);

    // The key is per user: someone else may use the same client_id.
    $other = User::factory()->create();
    $channel->members()->attach($other->id);
    sendMessage($other, $channel, ['client_id' => $clientId])->assertCreated();
    expect(Message::count())->toBe(2);
});

test('a client_id already used in another channel is rejected', function () {
    $user = User::factory()->create();
    $a = publicChannel($user, 'a');
    $b = publicChannel($user, 'b');
    $clientId = (string) Str::uuid();

    sendMessage($user, $a, ['client_id' => $clientId])->assertCreated();
    sendMessage($user, $b, ['client_id' => $clientId])->assertUnprocessable()->assertJsonValidationErrors('client_id');

    expect(Message::count())->toBe(1);
});

test('message validation', function (array $data, string $field) {
    $user = User::factory()->create();
    $channel = publicChannel($user);

    asUser($user)->postJson("/api/v1/channels/{$channel->id}/messages", $data)
        ->assertUnprocessable()->assertJsonValidationErrors($field);

    expect(Message::count())->toBe(0);
})->with([
    'missing body' => [['client_id' => '0b6f1f7e-3f53-4f3c-9d6e-0d3c1f6e2a10'], 'body'],
    'blank body' => [['body' => "  \n\t ", 'client_id' => '0b6f1f7e-3f53-4f3c-9d6e-0d3c1f6e2a10'], 'body'],
    'array body' => [['body' => ['x'], 'client_id' => '0b6f1f7e-3f53-4f3c-9d6e-0d3c1f6e2a10'], 'body'],
    'missing client_id' => [['body' => 'x'], 'client_id'],
    'non uuid client_id' => [['body' => 'x', 'client_id' => 'abc'], 'client_id'],
    'non integer parent' => [['body' => 'x', 'client_id' => '0b6f1f7e-3f53-4f3c-9d6e-0d3c1f6e2a10', 'parent_id' => 'x'], 'parent_id'],
]);

test('body_over_4000_chars_rejected', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);

    sendMessage($user, $channel, ['body' => str_repeat('a', 4001)])
        ->assertUnprocessable()->assertJsonValidationErrors('body');

    // Characters are counted, not bytes: 4000 Hebrew letters are 8000 bytes.
    sendMessage($user, $channel, ['body' => str_repeat('א', 4000)])->assertCreated();
    sendMessage($user, $channel, ['body' => str_repeat('א', 4001)])
        ->assertUnprocessable()->assertJsonValidationErrors('body');
    sendMessage($user, $channel, ['body' => str_repeat('😀', 4001)])
        ->assertUnprocessable()->assertJsonValidationErrors('body');

    // Surrounding whitespace does not count.
    sendMessage($user, $channel, ['body' => '  '.str_repeat('b', 4000)."\n"])
        ->assertCreated()->assertJson(['body' => str_repeat('b', 4000)]);

    expect(Message::count())->toBe(2);
});

test('hebrew, english and emoji bodies round-trip unchanged', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $body = "שלום world 👋🏽 — מה נשמע? ok\n🇮🇱 עברית + English 123";

    $id = sendMessage($user, $channel, ['body' => $body])->assertCreated()->assertJson(['body' => $body])->json('id');

    expect(Message::findOrFail($id)->body)->toBe($body);
    expect(asUser($user)->getJson("/api/v1/channels/{$channel->id}/messages")->json('data.0.body'))->toBe($body);
});

test('bidi marks at the edges of a body are kept, surrounding whitespace is not', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $rlm = "\u{200F}";
    $body = "{$rlm}שלום, ok?{$rlm}";

    $id = sendMessage($user, $channel, ['body' => " \t{$body}\n "])->assertCreated()->assertJson(['body' => $body])->json('id');
    expect(Message::findOrFail($id)->body)->toBe($body);

    $edited = "\u{200E}hello\u{061C}";
    asUser($user)->patchJson("/api/v1/messages/{$id}", ['body' => "  {$edited}\r\n"])->assertOk()->assertJson(['body' => $edited]);
    expect(Message::findOrFail($id)->body)->toBe($edited);

    // Other inputs are still trimmed by the global middleware.
    sendMessage($user, $channel, ['client_id' => ' '.Str::uuid().' '])->assertCreated();
});

test('a post racing the same client_id answers with the winner (200)', function () {
    Event::fake([MessageCreated::class]);
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $clientId = (string) Str::uuid();

    // The concurrent request inserts its row after our replay check, right when we take the channel lock.
    $raced = false;
    DB::listen(function (QueryExecuted $query) use (&$raced, $user, $channel, $clientId) {
        if (! $raced && str_contains($query->sql, 'for update') && str_contains($query->sql, '"channels"')) {
            $raced = true;
            message($user, $channel, 'the winner')->forceFill(['client_id' => $clientId])->save();
        }
    });

    $winner = sendMessage($user, $channel, ['body' => 'the loser', 'client_id' => $clientId])
        ->assertOk()->assertJson(['body' => 'the winner', 'client_id' => $clientId])->json('id');

    expect($raced)->toBeTrue()
        ->and(Message::pluck('id')->all())->toBe([$winner]);
    Event::assertNotDispatched(MessageCreated::class);
});

test('a removal committed while posting wins over the post', function () {
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = privateChannel($owner);
    $channel->members()->attach($member->id);

    // The removal lands between the policy check and the channel lock.
    DB::listen(function (QueryExecuted $query) use ($channel, $member) {
        if (str_contains($query->sql, 'for update') && str_contains($query->sql, '"channels"')) {
            $channel->members()->detach($member->id);
        }
    });

    sendMessage($member, $channel)->assertForbidden();
    expect(Message::count())->toBe(0);
});

test('removed_author_cannot_edit_but_can_delete_own_message', function () {
    Event::fake([MessageUpdated::class, MessageDeleted::class]);
    $owner = User::factory()->create();
    $author = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($author->id);
    $message = message($author, $channel, 'said while a member');

    asUser($owner)->deleteJson("/api/v1/channels/{$channel->id}/members/{$author->id}")->assertNoContent();

    // Public channel: still readable, but no longer writable, edits included.
    asUser($author)->patchJson("/api/v1/messages/{$message->id}", ['body' => 'rewritten after leaving'])->assertForbidden();
    expect($message->fresh())->body->toBe('said while a member')->edited_at->toBeNull();
    Event::assertNotDispatched(MessageUpdated::class);

    // Authors can always take their own words back.
    asUser($author)->deleteJson("/api/v1/messages/{$message->id}")->assertOk()->assertJson(['deleted' => true]);
    Event::assertDispatchedTimes(MessageDeleted::class, 1);

    // In a private channel, a former member sees nothing at all.
    $private = privateChannel($owner, 'secret');
    $private->members()->attach($author->id);
    $hidden = message($author, $private);
    $private->members()->detach($author->id);
    asUser($author)->patchJson("/api/v1/messages/{$hidden->id}", ['body' => 'x'])->assertNotFound();
    asUser($author)->deleteJson("/api/v1/messages/{$hidden->id}")->assertNotFound();
});

test('only_author_can_edit_or_delete', function () {
    Event::fake([MessageUpdated::class, MessageDeleted::class]);
    $author = User::factory()->create();
    $other = User::factory()->create();
    $channel = publicChannel($author);
    $channel->members()->attach($other->id, ['role' => 'owner']);
    $message = message($author, $channel, 'original');

    // Not even a channel owner may touch someone else's message.
    asUser($other)->patchJson("/api/v1/messages/{$message->id}", ['body' => 'hijacked'])->assertForbidden();
    asUser($other)->deleteJson("/api/v1/messages/{$message->id}")->assertForbidden();
    expect($message->fresh())->body->toBe('original')->edited_at->toBeNull()->deleted_at->toBeNull();
    Event::assertNothingDispatched();

    asUser($author)->patchJson("/api/v1/messages/{$message->id}", ['body' => '  edited  '])
        ->assertOk()
        ->assertJson(['id' => $message->id, 'body' => 'edited', 'deleted' => false]);
    expect($message->fresh()->edited_at)->not->toBeNull();
    expect(asUser($author)->getJson("/api/v1/channels/{$channel->id}/messages")->json('data.0.edited_at'))->not->toBeNull();

    asUser($author)->deleteJson("/api/v1/messages/{$message->id}")
        ->assertOk()
        ->assertExactJson([
            'id' => $message->id,
            'channel_id' => $channel->id,
            'parent_id' => null,
            'created_at' => $message->created_at->toISOString(),
            'deleted' => true,
            'reply_count' => 0,
            'last_reply_at' => null,
        ]);
    expect($message->fresh()->deleted_at)->not->toBeNull();

    Event::assertDispatchedTimes(MessageUpdated::class, 1);
    Event::assertDispatchedTimes(MessageDeleted::class, 1);
});

test('edit validates the body like a new message', function () {
    $author = User::factory()->create();
    $message = message($author, publicChannel($author));

    asUser($author)->patchJson("/api/v1/messages/{$message->id}", ['body' => ' '])->assertUnprocessable()->assertJsonValidationErrors('body');
    asUser($author)->patchJson("/api/v1/messages/{$message->id}", ['body' => str_repeat('x', 4001)])->assertUnprocessable();

    expect($message->fresh()->body)->toBe('hi');
});

test('an edit with an unchanged body is a no-op', function () {
    Event::fake([MessageUpdated::class]);
    $author = User::factory()->create();
    $message = message($author, publicChannel($author), 'same');

    asUser($author)->patchJson("/api/v1/messages/{$message->id}", ['body' => 'same'])->assertOk()->assertJson(['edited_at' => null]);

    expect($message->fresh()->edited_at)->toBeNull();
    Event::assertNotDispatched(MessageUpdated::class);
});

test('a deleted message cannot be edited and deleting it again is a no-op', function () {
    Event::fake([MessageUpdated::class, MessageDeleted::class]);
    $author = User::factory()->create();
    $other = User::factory()->create();
    $channel = publicChannel($author);
    $channel->members()->attach($other->id);
    $message = message($author, $channel, 'gone');

    asUser($author)->deleteJson("/api/v1/messages/{$message->id}")->assertOk();
    $deletedAt = $message->fresh()->deleted_at;

    asUser($author)->patchJson("/api/v1/messages/{$message->id}", ['body' => 'back'])->assertNotFound();
    asUser($author)->deleteJson("/api/v1/messages/{$message->id}")->assertOk()->assertJson(['deleted' => true]);
    asUser($other)->deleteJson("/api/v1/messages/{$message->id}")->assertForbidden();

    expect($message->fresh())->body->toBe('gone')->deleted_at->toEqual($deletedAt);
    Event::assertNotDispatched(MessageUpdated::class);
    Event::assertDispatchedTimes(MessageDeleted::class, 1);
});

test('thread_reply_requires_parent_in_same_channel', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user, 'here');
    $elsewhere = publicChannel($user, 'elsewhere');
    $parent = message($user, $channel, 'question');
    $foreign = message($user, $elsewhere, 'other channel');
    $reply = message($user, $channel, 'a reply', $parent);

    // Another channel's message, a reply (no nested threads) and a missing message are all refused.
    foreach ([$foreign->id, $reply->id, 999999] as $parentId) {
        sendMessage($user, $channel, ['parent_id' => $parentId])
            ->assertUnprocessable()->assertJsonValidationErrors('parent_id');
    }
    expect(Message::count())->toBe(3);

    $created = sendMessage($user, $channel, ['parent_id' => $parent->id, 'body' => 'answer'])
        ->assertCreated()
        ->assertJson(['parent_id' => $parent->id, 'reply_count' => 0, 'last_reply_at' => null])
        ->json();

    // Replies stay out of the channel timeline; the parent carries the summary.
    $timeline = asUser($user)->getJson("/api/v1/channels/{$channel->id}/messages")->assertOk()->json('data');
    expect(collect($timeline)->pluck('id')->all())->toBe([$parent->id]);
    expect($timeline[0]['reply_count'])->toBe(2)
        ->and($timeline[0]['last_reply_at'])->toBe($created['created_at']);

    asUser($user)->getJson("/api/v1/messages/{$parent->id}/replies")
        ->assertOk()
        ->assertJsonPath('parent.id', $parent->id)
        ->assertJsonPath('data.*.id', [$reply->id, $created['id']])
        ->assertJsonPath('has_more', false);

    // A reply has no thread of its own.
    asUser($user)->getJson("/api/v1/messages/{$reply->id}/replies")->assertNotFound();
});

test('deleted_parent_keeps_replies_visible', function () {
    $author = User::factory()->create();
    $replier = User::factory()->create();
    $channel = publicChannel($author);
    $channel->members()->attach($replier->id);
    $parent = message($author, $channel, 'secret question');
    $first = message($replier, $channel, 'first answer', $parent);
    $second = message($replier, $channel, 'second answer', $parent);

    asUser($author)->deleteJson("/api/v1/messages/{$parent->id}")->assertOk();

    $timeline = asUser($replier)->getJson("/api/v1/channels/{$channel->id}/messages")->assertOk()->json('data');
    expect($timeline)->toHaveCount(1);
    expect($timeline[0])
        ->toMatchArray(['id' => $parent->id, 'deleted' => true, 'reply_count' => 2])
        ->not->toHaveKeys(['body', 'user', 'client_id', 'reactions', 'edited_at']);

    $thread = asUser($replier)->getJson("/api/v1/messages/{$parent->id}/replies")->assertOk()->json();
    expect($thread['parent'])->toMatchArray(['id' => $parent->id, 'deleted' => true])->not->toHaveKey('body');
    expect(collect($thread['data'])->pluck('body')->all())->toBe(['first answer', 'second answer']);

    // The thread stays open.
    sendMessage($replier, $channel, ['parent_id' => $parent->id])->assertCreated();

    // A deleted reply is a tombstone in the thread and does not count.
    asUser($replier)->deleteJson("/api/v1/messages/{$first->id}")->assertOk();
    $thread = asUser($author)->getJson("/api/v1/messages/{$parent->id}/replies")->json('data');
    expect($thread[0])->toMatchArray(['id' => $first->id, 'deleted' => true])->not->toHaveKey('body');
    expect($thread[1]['body'])->toBe('second answer');
    expect(asUser($author)->getJson("/api/v1/channels/{$channel->id}/messages")->json('data.0.reply_count'))->toBe(2);
});

test('after_cursor_returns_missed_messages_in_order_without_duplicates', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $other = publicChannel($user, 'other');
    $ids = collect(range(1, 5))->map(fn ($i) => message($user, $channel, "m{$i}")->id);
    message($user, $other, 'noise');
    message($user, $channel, 'thread noise', Message::find($ids[0]));

    // The client saw up to m2, then lost its socket.
    asUser($user)->getJson("/api/v1/channels/{$channel->id}/messages?after={$ids[1]}")
        ->assertOk()
        ->assertJsonPath('data.*.id', $ids->slice(2)->values()->all())
        ->assertJsonPath('has_more', false);

    // Page by page: every message exactly once, in order.
    $seen = [];
    $cursor = $ids[0];
    do {
        $page = asUser($user)->getJson("/api/v1/channels/{$channel->id}/messages?after={$cursor}&limit=2")->assertOk()->json();
        $seen = array_merge($seen, array_column($page['data'], 'id'));
        $cursor = end($page['data'])['id'] ?? $cursor;
    } while ($page['has_more']);

    expect($seen)->toBe($ids->slice(1)->values()->all());

    // Nothing newer than the last message.
    asUser($user)->getJson("/api/v1/channels/{$channel->id}/messages?after={$ids[4]}")
        ->assertOk()->assertExactJson(['data' => [], 'has_more' => false]);
});

test('before cursor pages back through history', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $ids = collect(range(1, 7))->map(fn ($i) => message($user, $channel, "m{$i}")->id)->all();

    // No cursor: the latest messages, oldest first.
    asUser($user)->getJson("/api/v1/channels/{$channel->id}/messages?limit=3")
        ->assertOk()->assertJsonPath('data.*.id', array_slice($ids, 4, 3))->assertJsonPath('has_more', true);

    asUser($user)->getJson("/api/v1/channels/{$channel->id}/messages?limit=3&before={$ids[4]}")
        ->assertOk()->assertJsonPath('data.*.id', array_slice($ids, 1, 3))->assertJsonPath('has_more', true);

    asUser($user)->getJson("/api/v1/channels/{$channel->id}/messages?limit=3&before={$ids[1]}")
        ->assertOk()->assertJsonPath('data.*.id', [$ids[0]])->assertJsonPath('has_more', false);

    // Default page size is 50.
    expect(asUser($user)->getJson("/api/v1/channels/{$channel->id}/messages")->json('data'))->toHaveCount(7);
});

test('pagination parameters are validated', function (string $query) {
    $user = User::factory()->create();
    $channel = publicChannel($user);

    asUser($user)->getJson("/api/v1/channels/{$channel->id}/messages?{$query}")->assertUnprocessable();
})->with([
    'limit too high' => ['limit=101'],
    'limit zero' => ['limit=0'],
    'non numeric cursor' => ['after=abc'],
    'both cursors' => ['before=10&after=2'],
]);

test('limit is capped at 100', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    Message::factory()->count(101)->create(['channel_id' => $channel->id, 'user_id' => $user->id]);

    $page = asUser($user)->getJson("/api/v1/channels/{$channel->id}/messages?limit=100")->assertOk()->json();

    expect($page['data'])->toHaveCount(100)->and($page['has_more'])->toBeTrue();
});

test('replies can be paged with the same cursors', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $parent = message($user, $channel);
    $replies = collect(range(1, 3))->map(fn ($i) => message($user, $channel, "r{$i}", $parent)->id)->all();

    asUser($user)->getJson("/api/v1/messages/{$parent->id}/replies?after={$replies[0]}&limit=1")
        ->assertOk()->assertJsonPath('data.*.id', [$replies[1]])->assertJsonPath('has_more', true);
});

test('rate_limit_30_messages_per_minute', function () {
    $user = User::factory()->create();
    $neighbour = User::factory()->create();
    $channel = publicChannel($user);
    $channel->members()->attach($neighbour->id);

    for ($i = 0; $i < 30; $i++) {
        sendMessage($user, $channel)->assertCreated();
    }
    sendMessage($user, $channel)->assertTooManyRequests();
    expect(Message::count())->toBe(30);

    // The limit is per user.
    sendMessage($neighbour, $channel)->assertCreated();

    $this->travel(61)->seconds();
    sendMessage($user, $channel)->assertCreated();
});

test('message routes are closed to non-members of a private channel (404)', function () {
    $owner = User::factory()->create();
    $outsider = User::factory()->create();
    $channel = privateChannel($owner);
    $message = message($owner, $channel);
    $as = fn () => asUser($outsider);

    $as()->getJson("/api/v1/channels/{$channel->id}/messages")->assertNotFound();
    sendMessage($outsider, $channel)->assertNotFound();
    $as()->getJson("/api/v1/messages/{$message->id}/replies")->assertNotFound();
    $as()->patchJson("/api/v1/messages/{$message->id}", ['body' => 'x'])->assertNotFound();
    $as()->deleteJson("/api/v1/messages/{$message->id}")->assertNotFound();
    $as()->putJson("/api/v1/messages/{$message->id}/reactions/".rawurlencode('👍'))->assertNotFound();
    $as()->deleteJson("/api/v1/messages/{$message->id}/reactions/".rawurlencode('👍'))->assertNotFound();

    expect(Message::count())->toBe(1)->and($message->reactions()->count())->toBe(0);

    // The same holds for a DM between two other people.
    $dm = Channel::factory()->create(['kind' => Channel::KIND_DM, 'name' => null]);
    $dm->members()->attach($owner->id);
    $as()->getJson("/api/v1/channels/{$dm->id}/messages")->assertNotFound();
    sendMessage($outsider, $dm)->assertNotFound();
});

test('a public channel can be read but not written by non-members (403)', function () {
    $owner = User::factory()->create();
    $outsider = User::factory()->create();
    $channel = publicChannel($owner);
    $message = message($owner, $channel);

    asUser($outsider)->getJson("/api/v1/channels/{$channel->id}/messages")->assertOk()->assertJsonPath('data.0.id', $message->id);
    asUser($outsider)->getJson("/api/v1/messages/{$message->id}/replies")->assertOk();
    sendMessage($outsider, $channel)->assertForbidden();
    sendMessage($outsider, $channel, ['parent_id' => $message->id])->assertForbidden();
    asUser($outsider)->putJson("/api/v1/messages/{$message->id}/reactions/".rawurlencode('👍'))->assertForbidden();
    asUser($outsider)->deleteJson("/api/v1/messages/{$message->id}/reactions/".rawurlencode('👍'))->assertForbidden();

    expect(Message::count())->toBe(1);
});

test('members of a DM can talk', function () {
    $a = User::factory()->create();
    $b = User::factory()->create();
    $dm = Channel::factory()->create(['kind' => Channel::KIND_DM, 'name' => null]);
    $dm->members()->attach([$a->id, $b->id]);

    sendMessage($a, $dm, ['body' => 'psst'])->assertCreated();
    asUser($b)->getJson("/api/v1/channels/{$dm->id}/messages")->assertOk()->assertJsonPath('data.0.body', 'psst');
});

test('messages require a session and an unbanned account', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $message = message($user, $channel);

    test()->withHeaders(['Referer' => 'http://localhost/'])->getJson("/api/v1/channels/{$channel->id}/messages")->assertUnauthorized();
    test()->withHeaders(['Referer' => 'http://localhost/'])->deleteJson("/api/v1/messages/{$message->id}")->assertUnauthorized();

    $user->forceFill(['banned_at' => now()])->save();
    sendMessage($user, $channel)->assertForbidden()->assertExactJson(['error' => 'account_banned']);
});

test('message_created_is_broadcast_once_after_commit', function () {
    Event::fake([MessageCreated::class]);
    $user = User::factory()->create();
    $channel = publicChannel($user);

    // Rolled back: nothing goes out.
    DB::beginTransaction();
    sendMessage($user, $channel)->assertCreated();
    Event::assertNotDispatched(MessageCreated::class);
    DB::rollBack();
    Event::assertNotDispatched(MessageCreated::class);

    // Committed: exactly one event, only once the commit happened.
    DB::beginTransaction();
    $response = sendMessage($user, $channel)->assertCreated();
    Event::assertNotDispatched(MessageCreated::class);
    DB::commit();

    Event::assertDispatchedTimes(MessageCreated::class, 1);
    $event = Event::dispatched(MessageCreated::class)->first()[0];
    expect($event->broadcastOn()[0]->name)->toBe("private-channel.{$channel->id}")
        ->and($event->broadcastAs())->toBe('message.created')
        ->and($event->broadcastWith())->toBe($response->json());
});

test('edits and deletions are broadcast with the REST shape', function () {
    Event::fake([MessageUpdated::class, MessageDeleted::class]);
    $author = User::factory()->create();
    $channel = publicChannel($author);
    $message = message($author, $channel, 'v1');

    $edited = asUser($author)->patchJson("/api/v1/messages/{$message->id}", ['body' => 'v2'])->assertOk()->json();
    $deleted = asUser($author)->deleteJson("/api/v1/messages/{$message->id}")->assertOk()->json();

    $updated = Event::dispatched(MessageUpdated::class)->sole()[0];
    expect($updated->broadcastAs())->toBe('message.updated')
        ->and($updated->broadcastOn()[0]->name)->toBe("private-channel.{$channel->id}")
        ->and($updated->broadcastWith())->toBe($edited)
        ->and($updated->broadcastWith()['body'])->toBe('v2');

    $gone = Event::dispatched(MessageDeleted::class)->sole()[0];
    expect($gone->broadcastAs())->toBe('message.deleted')
        ->and($gone->broadcastWith())->toBe($deleted)
        ->and($gone->broadcastWith())->not->toHaveKey('body');
});

test('a reply is broadcast on the channel with its parent id', function () {
    Event::fake([MessageCreated::class]);
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $parent = message($user, $channel);

    sendMessage($user, $channel, ['parent_id' => $parent->id])->assertCreated();

    Event::assertDispatched(MessageCreated::class, fn ($e) => $e->broadcastWith()['parent_id'] === $parent->id
        && $e->broadcastOn()[0]->name === "private-channel.{$channel->id}");
});
