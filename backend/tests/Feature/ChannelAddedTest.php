<?php

use App\Events\ChannelAdded;
use App\Events\MessageCreated;
use App\Models\User;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Broadcasting\BroadcastEvent;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

/** @return list<int> the users told, in dispatch order */
function addedRecipients(): array
{
    return Event::dispatched(ChannelAdded::class)->map(fn ($call) => $call[0]->userId)->values()->all();
}

test('a new dm is pushed to the other participant only, on their own channel, with the channel id alone', function () {
    Event::fake([ChannelAdded::class]);
    [$alice, $bob] = User::factory()->count(2)->create();

    $id = asUser($alice)->postJson('/api/v1/dms', ['user_ids' => [$bob->id]])->assertCreated()->json('id');

    expect(addedRecipients())->toBe([$bob->id]);
    $event = Event::dispatched(ChannelAdded::class)->sole()[0];
    expect(array_map(fn ($channel) => $channel->name, $event->broadcastOn()))->toBe(["private-App.Models.User.{$bob->id}"])
        ->and($event->broadcastAs())->toBe('channel.added')
        ->and($event->broadcastWith())->toBe(['channel_id' => $id]);
});

test('a new group dm is pushed to every participant but the caller', function () {
    Event::fake([ChannelAdded::class]);
    [$alice, $bob, $carol, $dana] = User::factory()->count(4)->create();

    $id = asUser($alice)->postJson('/api/v1/dms', ['user_ids' => [$dana->id, $bob->id, $carol->id]])->assertCreated()->json('id');

    expect(addedRecipients())->toEqualCanonicalizing([$bob->id, $carol->id, $dana->id]);
    Event::assertDispatched(ChannelAdded::class, fn (ChannelAdded $e) => $e->broadcastWith() === ['channel_id' => $id]);
});

test('opening a conversation that already exists pushes nothing', function () {
    [$alice, $bob] = User::factory()->count(2)->create();
    asUser($alice)->postJson('/api/v1/dms', ['user_ids' => [$bob->id]])->assertCreated();

    Event::fake([ChannelAdded::class]);
    asUser($alice)->postJson('/api/v1/dms', ['user_ids' => [$bob->id]])->assertOk();
    asUser($bob)->postJson('/api/v1/dms', ['user_ids' => [$alice->id]])->assertOk();

    Event::assertNotDispatched(ChannelAdded::class);
});

test('an owner adding someone pushes it to them, once', function () {
    Event::fake([ChannelAdded::class]);
    $owner = User::factory()->create();
    $newcomer = User::factory()->create();
    $channel = privateChannel($owner);

    asUser($owner)->postJson("/api/v1/channels/{$channel->id}/members", ['user_id' => $newcomer->id])->assertCreated();
    expect(addedRecipients())->toBe([$newcomer->id]);
    expect(Event::dispatched(ChannelAdded::class)->sole()[0]->broadcastWith())->toBe(['channel_id' => $channel->id]);

    // Already a member: nothing new to tell.
    asUser($owner)->postJson("/api/v1/channels/{$channel->id}/members", ['user_id' => $newcomer->id])->assertOk();
    Event::assertDispatchedTimes(ChannelAdded::class, 1);
});

test('joining by oneself or leaving pushes nothing', function () {
    Event::fake([ChannelAdded::class]);
    $owner = User::factory()->create();
    $joiner = User::factory()->create();
    $channel = publicChannel($owner);

    asUser($joiner)->postJson("/api/v1/channels/{$channel->id}/join")->assertOk();
    asUser($joiner)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNoContent();
    asUser($owner)->postJson("/api/v1/channels/{$channel->id}/members", ['user_id' => $joiner->id])->assertCreated();
    asUser($owner)->deleteJson("/api/v1/channels/{$channel->id}/members/{$joiner->id}")->assertNoContent();

    // Only the owner's addition counted.
    expect(addedRecipients())->toBe([$joiner->id]);
});

test('a banned user is never told', function () {
    Event::fake([ChannelAdded::class]);
    [$alice, $bob, $carol] = User::factory()->count(3)->create();
    $channel = privateChannel($alice);
    $bob->forceFill(['banned_at' => now()])->save();

    asUser($alice)->postJson('/api/v1/dms', ['user_ids' => [$bob->id]])->assertUnprocessable();
    asUser($alice)->postJson('/api/v1/dms', ['user_ids' => [$bob->id, $carol->id]])->assertUnprocessable();
    asUser($alice)->postJson("/api/v1/channels/{$channel->id}/members", ['user_id' => $bob->id])->assertUnprocessable();

    Event::assertNotDispatched(ChannelAdded::class);
});

test('channel.added goes out only once the creation is committed', function () {
    Event::fake([ChannelAdded::class]);
    [$alice, $bob, $carol] = User::factory()->count(3)->create();
    $channel = privateChannel($alice);

    // Rolled back: nothing goes out.
    DB::beginTransaction();
    asUser($alice)->postJson('/api/v1/dms', ['user_ids' => [$bob->id]])->assertCreated();
    asUser($alice)->postJson("/api/v1/channels/{$channel->id}/members", ['user_id' => $carol->id])->assertCreated();
    Event::assertNotDispatched(ChannelAdded::class);
    DB::rollBack();
    Event::assertNotDispatched(ChannelAdded::class);

    // Committed: out only after the commit.
    DB::beginTransaction();
    asUser($alice)->postJson('/api/v1/dms', ['user_ids' => [$bob->id]])->assertCreated();
    asUser($alice)->postJson("/api/v1/channels/{$channel->id}/members", ['user_id' => $carol->id])->assertCreated();
    Event::assertNotDispatched(ChannelAdded::class);
    DB::commit();

    expect(addedRecipients())->toBe([$bob->id, $carol->id]);
});

test('channel.added is queued like the message events', function () {
    fakeReverb();
    Queue::fake();
    [$alice, $bob] = User::factory()->count(2)->create();

    $id = asUser($alice)->postJson('/api/v1/dms', ['user_ids' => [$bob->id]])->assertCreated()->json('id');
    asUser($alice)->postJson("/api/v1/channels/{$id}/messages", ['body' => 'hi', 'client_id' => (string) Str::uuid()])->assertCreated();

    $jobs = Queue::pushed(BroadcastEvent::class);
    $added = $jobs->first(fn (BroadcastEvent $job) => $job->event instanceof ChannelAdded);
    $message = $jobs->first(fn (BroadcastEvent $job) => $job->event instanceof MessageCreated);
    expect($added)->not->toBeNull()
        ->and($message)->not->toBeNull()
        ->and([$added->connection, $added->queue])->toBe([$message->connection, $message->queue]);
});

test('only the user may subscribe to their own channel', function () {
    fakeReverb();
    [$alice, $bob] = User::factory()->count(2)->create();

    authorizeChannelName($alice, "private-App.Models.User.{$alice->id}")->assertOk();
    authorizeChannelName($alice, "private-App.Models.User.{$bob->id}")->assertForbidden();
});
