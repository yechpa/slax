<?php

use App\Events\ReactionChanged;
use App\Models\Message;
use App\Models\Reaction;
use App\Models\User;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Support\Facades\Event;
use Illuminate\Testing\TestResponse;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

function react(User $user, Message $message, string $emoji, string $method = 'putJson'): TestResponse
{
    return asUser($user)->{$method}("/api/v1/messages/{$message->id}/reactions/".rawurlencode($emoji));
}

function unreact(User $user, Message $message, string $emoji): TestResponse
{
    return react($user, $message, $emoji, 'deleteJson');
}

/** A channel with two members and one message by the first. */
function reactionScene(): array
{
    $alice = User::factory()->create();
    $bob = User::factory()->create();
    $channel = publicChannel($alice);
    $channel->members()->attach($bob->id);
    $message = Message::factory()->create(['channel_id' => $channel->id, 'user_id' => $alice->id]);

    return [$alice, $bob, $channel, $message];
}

test('adding a reaction is idempotent', function () {
    Event::fake([ReactionChanged::class]);
    [$alice, $bob, , $message] = reactionScene();

    react($bob, $message, '👍')
        ->assertOk()
        ->assertJsonPath('id', $message->id)
        ->assertJsonPath('reactions', [['emoji' => '👍', 'count' => 1, 'reacted_by_me' => true, 'user_ids' => [$bob->id]]]);
    react($bob, $message, '👍')->assertOk()->assertJsonPath('reactions.0.count', 1);

    expect(Reaction::count())->toBe(1);
    Event::assertDispatchedTimes(ReactionChanged::class, 1);
});

test('removing a reaction is idempotent', function () {
    Event::fake([ReactionChanged::class]);
    [$alice, $bob, , $message] = reactionScene();
    react($bob, $message, '🎉')->assertOk();

    unreact($bob, $message, '🎉')->assertOk()->assertJsonPath('reactions', []);
    unreact($bob, $message, '🎉')->assertOk()->assertJsonPath('reactions', []);
    // Removing one you never added changes nothing either.
    unreact($alice, $message, '🚀')->assertOk();

    expect(Reaction::count())->toBe(0);
    Event::assertDispatchedTimes(ReactionChanged::class, 2);
});

test('reactions are aggregated per emoji for the viewer', function () {
    [$alice, $bob, $channel, $message] = reactionScene();
    react($alice, $message, '👍');
    react($bob, $message, '👍');
    react($bob, $message, '❤️');

    $forAlice = asUser($alice)->getJson("/api/v1/channels/{$channel->id}/messages")->json('data.0.reactions');
    expect($forAlice)->toBe([
        ['emoji' => '👍', 'count' => 2, 'reacted_by_me' => true, 'user_ids' => [$alice->id, $bob->id]],
        ['emoji' => '❤️', 'count' => 1, 'reacted_by_me' => false, 'user_ids' => [$bob->id]],
    ]);

    $outsider = User::factory()->create();
    $forOutsider = asUser($outsider)->getJson("/api/v1/channels/{$channel->id}/messages")->json('data.0.reactions');
    expect(array_column($forOutsider, 'reacted_by_me'))->toBe([false, false]);
});

test('the reaction broadcast carries the aggregate, not the actor view', function () {
    Event::fake([ReactionChanged::class]);
    [, $bob, $channel, $message] = reactionScene();

    react($bob, $message, '👀')->assertOk();

    $event = Event::dispatched(ReactionChanged::class)->sole()[0];
    expect($event->broadcastAs())->toBe('reaction.changed')
        ->and($event->broadcastOn()[0]->name)->toBe("private-channel.{$channel->id}")
        ->and($event->broadcastWith()['id'])->toBe($message->id)
        ->and($event->broadcastWith()['reactions'])->toBe([
            ['emoji' => '👀', 'count' => 1, 'reacted_by_me' => false, 'user_ids' => [$bob->id]],
        ]);
});

test('only a single emoji is accepted', function (string $emoji) {
    [, $bob, , $message] = reactionScene();

    react($bob, $message, $emoji)->assertUnprocessable()->assertJsonValidationErrors('emoji');

    expect(Reaction::count())->toBe(0);
})->with([
    'word' => ['abc'],
    'letter' => ['a'],
    'digit' => ['7'],
    'hebrew letter' => ['א'],
    'two emoji' => ['👍👍'],
    'emoji and text' => ['👍a'],
    'shortcode' => [':thumbsup:'],
    'space' => [' '],
    'longer than 16 bytes' => ['👨‍👩‍👧‍👦'],
    'zero width joiner alone' => ["\u{200D}"],
]);

test('common emoji are accepted', function (string $emoji) {
    [, $bob, , $message] = reactionScene();

    react($bob, $message, $emoji)->assertOk()->assertJsonPath('reactions.0.emoji', $emoji);
})->with([
    'thumbs up' => ['👍'],
    'skin tone' => ['👍🏽'],
    'variation selector' => ['❤️'],
    'flag' => ['🇮🇱'],
    'keycap' => ['1️⃣'],
    'zwj sequence' => ['🧑‍💻'],
]);

test('a message accepts at most 20 distinct emoji', function () {
    [$alice, $bob, , $message] = reactionScene();
    $emoji = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙', '😚', '🙂', '🤗'];

    foreach ($emoji as $e) {
        react($bob, $message, $e)->assertOk();
    }
    react($bob, $message, '🤔')->assertUnprocessable()->assertJsonValidationErrors('emoji');
    react($alice, $message, '🤔')->assertUnprocessable();

    // Joining an existing emoji is still fine, and so is repeating one's own.
    react($alice, $message, '😀')->assertOk()->assertJsonPath('reactions.0.count', 2);
    react($bob, $message, '😀')->assertOk();

    expect(Reaction::count())->toBe(21)
        ->and(Reaction::distinct()->count('emoji'))->toBe(20);
});

test('a deleted message takes no reactions', function () {
    [$alice, $bob, , $message] = reactionScene();
    react($bob, $message, '👍')->assertOk();
    asUser($alice)->deleteJson("/api/v1/messages/{$message->id}")->assertOk();

    react($bob, $message, '🎉')->assertNotFound();
    unreact($bob, $message, '👍')->assertNotFound();

    expect(Reaction::count())->toBe(1);
});

test('a missing message is a 404', function () {
    $user = User::factory()->create();

    asUser($user)->putJson('/api/v1/messages/999999/reactions/'.rawurlencode('👍'))->assertNotFound();
});

test('a reply can be reacted to', function () {
    [$alice, $bob, $channel, $message] = reactionScene();
    $reply = Message::factory()->create(['channel_id' => $channel->id, 'user_id' => $alice->id, 'parent_id' => $message->id]);

    react($bob, $reply, '✅')->assertOk()->assertJsonPath('parent_id', $message->id);
    asUser($alice)->getJson("/api/v1/messages/{$message->id}/replies")->assertJsonPath('data.0.reactions.0.emoji', '✅');
});

test('a member who left cannot react any more', function () {
    [$alice, $bob, $channel, $message] = reactionScene();
    $channel->members()->detach($bob->id);

    react($bob, $message, '👍')->assertForbidden();

    $secret = privateChannel($alice, 'secret');
    $hidden = Message::factory()->create(['channel_id' => $secret->id, 'user_id' => $alice->id]);
    react($bob, $hidden, '👍')->assertNotFound();
    expect(Reaction::count())->toBe(0);
});
