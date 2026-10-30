<?php

use App\Events\UserRegistered;
use App\Models\Channel;
use App\Models\Message;
use App\Models\User;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

function posted(User $user, Channel $channel, ?Message $parent = null): Message
{
    return Message::factory()->create(['channel_id' => $channel->id, 'user_id' => $user->id, 'parent_id' => $parent?->id]);
}

function markRead(User $user, Channel $channel, mixed $messageId): TestResponse
{
    return asUser($user)->postJson("/api/v1/channels/{$channel->id}/read", ['message_id' => $messageId]);
}

function lastRead(User $user, Channel $channel): ?int
{
    return DB::table('channel_members')->where(['channel_id' => $channel->id, 'user_id' => $user->id])->value('last_read_message_id');
}

/** The caller's row for this channel in GET /channels. */
function listed(User $user, Channel $channel): array
{
    return collect(asUser($user)->getJson('/api/v1/channels')->assertOk()->json())->firstWhere('id', $channel->id);
}

test('mark_read_moves_the_pointer_forward_only', function () {
    $alice = User::factory()->create();
    $bob = User::factory()->create();
    $channel = publicChannel($alice);
    $channel->addMember($bob);
    [$first, $second] = [posted($bob, $channel), posted($bob, $channel)];

    markRead($alice, $channel, $second->id)->assertNoContent();
    expect(lastRead($alice, $channel))->toBe($second->id);

    // An older id (a slow request, another tab) never moves it back.
    markRead($alice, $channel, $first->id)->assertNoContent();
    expect(lastRead($alice, $channel))->toBe($second->id)
        ->and(lastRead($bob, $channel))->toBeNull();
});

test('mark_read_requires_membership_404', function () {
    $owner = User::factory()->create();
    $outsider = User::factory()->create();
    $public = publicChannel($owner);
    $private = privateChannel($owner);
    $publicMessage = posted($owner, $public);
    $privateMessage = posted($owner, $private);

    // Public channels are readable without joining, but there is no read pointer to move.
    markRead($outsider, $public, $publicMessage->id)->assertNotFound();
    markRead($outsider, $private, $privateMessage->id)->assertNotFound();

    expect(DB::table('channel_members')->where('user_id', $outsider->id)->count())->toBe(0);
});

test('mark_read_rejects_a_message_of_another_channel_422', function () {
    $alice = User::factory()->create();
    $channel = publicChannel($alice);
    $other = publicChannel($alice, 'other');
    $parent = posted($alice, $channel);
    $reply = posted($alice, $channel, $parent);

    markRead($alice, $channel, posted($alice, $other)->id)->assertUnprocessable()->assertJsonValidationErrors('message_id');
    // The pointer follows the channel timeline: thread replies are not part of it.
    markRead($alice, $channel, $reply->id)->assertUnprocessable()->assertJsonValidationErrors('message_id');
    markRead($alice, $channel, 999999)->assertUnprocessable()->assertJsonValidationErrors('message_id');
    markRead($alice, $channel, 'abc')->assertUnprocessable()->assertJsonValidationErrors('message_id');
    asUser($alice)->postJson("/api/v1/channels/{$channel->id}/read", [])->assertUnprocessable()->assertJsonValidationErrors('message_id');

    expect(lastRead($alice, $channel))->toBeNull();
});

test('unread_count_counts_new_top_level_messages_of_others_only', function () {
    $alice = User::factory()->create();
    $bob = User::factory()->create();
    $channel = publicChannel($alice);
    $channel->addMember($bob);

    $read = posted($bob, $channel);
    markRead($alice, $channel, $read->id)->assertNoContent();

    posted($bob, $channel);                         // counts
    $parent = posted($bob, $channel);               // counts
    posted($bob, $channel, $parent);                // reply: not in the timeline
    posted($alice, $channel);                       // her own: never unread
    posted($bob, $channel)->forceFill(['deleted_at' => now()])->save(); // tombstone

    expect(listed($alice, $channel))
        ->unread_count->toBe(2)
        ->last_read_message_id->toBe($read->id);

    markRead($alice, $channel, $parent->id)->assertNoContent();
    expect(listed($alice, $channel)['unread_count'])->toBe(0);
});

test('unread_count_is_zero_outside_and_true_count_above_99', function () {
    $alice = User::factory()->create();
    $bob = User::factory()->create();
    $joined = publicChannel($bob);
    $joined->addMember($alice);
    $notJoined = publicChannel($bob, 'elsewhere');
    Message::factory()->count(120)->create(['channel_id' => $joined->id, 'user_id' => $bob->id]);
    posted($bob, $notJoined);

    // The UI caps the badge; the API sends the true number.
    expect(listed($alice, $joined)['unread_count'])->toBe(120)
        ->and(listed($alice, $notJoined))->unread_count->toBe(0)->last_read_message_id->toBeNull()->is_member->toBeFalse();
});

test('channel_list_counts_unread_in_one_query_whatever_the_number_of_channels', function () {
    $alice = User::factory()->create();
    $bob = User::factory()->create();
    foreach (range(1, 6) as $i) {
        $channel = publicChannel($bob, "room-{$i}");
        $channel->addMember($alice);
        posted($bob, $channel);
    }

    $queries = [];
    DB::listen(function (QueryExecuted $query) use (&$queries) {
        if (str_contains($query->sql, 'messages')) {
            $queries[] = $query->sql;
        }
    });
    $rows = asUser($alice)->getJson('/api/v1/channels')->assertOk()->json();

    expect(collect($rows)->where('unread_count', 1))->toHaveCount(6)
        ->and($queries)->toHaveCount(1);
});

test('channels_carry_their_member_count', function () {
    $alice = User::factory()->create();
    $bob = User::factory()->create();
    $channel = publicChannel($alice);
    $channel->addMember($bob);

    expect(listed($alice, $channel)['member_count'])->toBe(2);
    asUser($alice)->getJson("/api/v1/channels/{$channel->id}")->assertOk()->assertJson(['member_count' => 2]);
});

test('joining_a_channel_starts_with_nothing_unread', function () {
    $bob = User::factory()->create();
    $channel = publicChannel($bob);
    $history = [posted($bob, $channel), posted($bob, $channel)];

    $alice = User::factory()->create();
    asUser($alice)->postJson("/api/v1/channels/{$channel->id}/join")->assertOk()
        ->assertJson(['unread_count' => 0, 'last_read_message_id' => $history[1]->id]);
    expect(listed($alice, $channel)['unread_count'])->toBe(0);

    posted($bob, $channel);
    expect(listed($alice, $channel)['unread_count'])->toBe(1);
});

test('a_new_user_lands_in_public_channels_with_nothing_unread', function () {
    $bob = User::factory()->create();
    $general = Channel::where('name', 'general')->sole();
    $latest = posted($bob, $general);

    $alice = User::factory()->create();
    UserRegistered::dispatch($alice);

    expect(lastRead($alice, $general))->toBe($latest->id)
        ->and(listed($alice, $general)['unread_count'])->toBe(0);
});
