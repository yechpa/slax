<?php

use App\Events\MemberRemoved;
use App\Events\UserRegistered;
use App\Http\Controllers\ChannelController;
use App\Models\Channel;
use App\Models\User;
use App\Models\Workspace;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

test('public_channel_visible_to_any_member', function () {
    $user = User::factory()->create();
    $general = Channel::where('name', 'general')->sole();

    $names = asUser($user)->getJson('/api/v1/channels')->assertOk()->json('*.name');
    expect($names)->toContain('general', 'random', 'ingenierie', 'securite');

    asUser($user)->getJson("/api/v1/channels/{$general->id}")
        ->assertOk()
        ->assertJson(['id' => $general->id, 'name' => 'general', 'kind' => 'public', 'is_member' => false]);

    $general->members()->attach($user->id);
    $row = collect(asUser($user)->getJson('/api/v1/channels')->json())->firstWhere('id', $general->id);
    expect($row['is_member'])->toBeTrue();
});

test('private_channel_hidden_from_non_members_404', function () {
    $owner = User::factory()->create();
    $outsider = User::factory()->create();
    $channel = privateChannel($owner);

    expect(asUser($outsider)->getJson('/api/v1/channels')->assertOk()->json('*.name'))->not->toContain('secret');
    asUser($outsider)->getJson("/api/v1/channels/{$channel->id}")->assertNotFound();
    asUser($outsider)->postJson("/api/v1/channels/{$channel->id}/join")->assertNotFound();
    asUser($outsider)->postJson("/api/v1/channels/{$channel->id}/members", ['user_id' => $outsider->id])->assertNotFound();
    asUser($outsider)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNotFound();
    expect($channel->members()->count())->toBe(1);

    expect(asUser($owner)->getJson('/api/v1/channels')->json('*.name'))->toContain('secret');
    asUser($owner)->getJson("/api/v1/channels/{$channel->id}")->assertOk();
});

test('non_member_cannot_post', function () {
    $owner = User::factory()->create();
    $outsider = User::factory()->create();
    $public = publicChannel($owner);
    $private = privateChannel($owner);

    expect($outsider->can('post', $public))->toBeFalse()
        ->and($outsider->can('post', $private))->toBeFalse()
        ->and($owner->can('post', $public))->toBeTrue()
        ->and($owner->can('post', $private))->toBeTrue();

    asUser($outsider)->postJson("/api/v1/channels/{$public->id}/join")->assertOk();

    expect($outsider->can('post', $public))->toBeTrue();
});

test('owner_can_add_and_remove_members', function () {
    Event::fake([MemberRemoved::class]);
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $newcomer = User::factory()->create();
    $channel = privateChannel($owner);
    $channel->members()->attach($member->id);

    // A plain member cannot manage.
    asUser($member)->postJson("/api/v1/channels/{$channel->id}/members", ['user_id' => $newcomer->id])->assertForbidden();
    asUser($member)->deleteJson("/api/v1/channels/{$channel->id}/members/{$owner->id}")->assertForbidden();

    // For a private channel, being added is the only way in.
    asUser($newcomer)->getJson("/api/v1/channels/{$channel->id}")->assertNotFound();
    asUser($owner)->postJson("/api/v1/channels/{$channel->id}/members", ['user_id' => $newcomer->id])
        ->assertCreated()
        ->assertJson(['channel_id' => $channel->id, 'user_id' => $newcomer->id, 'role' => 'member']);
    asUser($newcomer)->getJson("/api/v1/channels/{$channel->id}")->assertOk()->assertJson(['is_member' => true]);

    asUser($owner)->deleteJson("/api/v1/channels/{$channel->id}/members/{$newcomer->id}")->assertNoContent();

    expect($channel->members()->whereKey($newcomer->id)->exists())->toBeFalse();
    asUser($newcomer)->getJson("/api/v1/channels/{$channel->id}")->assertNotFound();
    Event::assertDispatchedTimes(MemberRemoved::class, 1);
    Event::assertDispatched(MemberRemoved::class, fn ($e) => $e->channel->is($channel) && $e->user->is($newcomer));
});

test('new_user_autojoins_public_channels', function () {
    $other = User::factory()->create();
    $secret = privateChannel($other);
    $user = User::factory()->create();

    UserRegistered::dispatch($user);

    $joined = $user->channels()->orderBy('name')->get();
    expect($joined->pluck('name')->all())->toBe(['general', 'ingenierie', 'random', 'securite'])
        ->and($joined->pluck('pivot.role')->unique()->all())->toBe(['member'])
        ->and($user->channels()->whereKey($secret->id)->exists())->toBeFalse();

    // Idempotent: a replayed event does not fail or duplicate.
    UserRegistered::dispatch($user);
    expect($user->channels()->count())->toBe(4);
});

test('channel_name_unique_per_workspace', function () {
    $workspace = Workspace::default();
    $other = Workspace::create(['name' => 'Other', 'slug' => 'other']);

    // Enforced by the database, across public and private channels alike.
    // (Inside a savepoint: a failed statement would otherwise poison the test transaction.)
    expect(fn () => DB::transaction(fn () => Channel::factory()->private()->create(['workspace_id' => $workspace->id, 'name' => 'general'])))
        ->toThrow(UniqueConstraintViolationException::class);

    // Another workspace may reuse the name; DMs have no name and are exempt.
    Channel::factory()->create(['workspace_id' => $other->id, 'name' => 'general']);
    Channel::factory()->dm()->count(2)->create(['workspace_id' => $workspace->id]);
    expect(Channel::where('kind', 'dm')->count())->toBe(2);

    // The API reports it as a validation error.
    asUser(User::factory()->create())->postJson('/api/v1/channels', ['name' => 'general', 'kind' => 'public'])
        ->assertUnprocessable()->assertJsonValidationErrors('name');
});

test('a taken name is refused with its own message, which other name refusals never use', function () {
    $user = User::factory()->create();

    // #general exists (seeded). The SPA says "taken" in the reader's language when, and only when, it reads this message.
    asUser($user)->postJson('/api/v1/channels', ['name' => 'general', 'kind' => 'public'])
        ->assertUnprocessable()->assertExactJsonStructure(['message', 'errors' => ['name']])
        ->assertJsonPath('errors.name', [ChannelController::NAME_TAKEN]);

    foreach (['-starts-with-dash', 'Capitals', str_repeat('a', 41)] as $name) {
        $messages = asUser($user)->postJson('/api/v1/channels', ['name' => $name, 'kind' => 'public'])
            ->assertUnprocessable()->json('errors.name');
        expect($messages)->not->toBeEmpty()->not->toContain(ChannelController::NAME_TAKEN);
    }
});

test('channels require a session', function () {
    test()->withHeaders(['Referer' => 'http://localhost/'])->getJson('/api/v1/channels')->assertUnauthorized();
});

test('creator becomes the owner of the channel', function () {
    $user = User::factory()->create();

    $response = asUser($user)->postJson('/api/v1/channels', ['name' => 'plans-2026', 'kind' => 'private', 'topic' => 'Roadmap'])
        ->assertCreated()
        ->assertJson(['name' => 'plans-2026', 'kind' => 'private', 'topic' => 'Roadmap', 'is_member' => true]);

    $channel = Channel::findOrFail($response->json('id'));
    expect($channel->workspace_id)->toBe(Workspace::default()->id)
        ->and($channel->members()->whereKey($user->id)->sole()->pivot->role)->toBe('owner');
});

test('invalid channel names and kinds are rejected', function (string $name, string $kind) {
    asUser(User::factory()->create())->postJson('/api/v1/channels', ['name' => $name, 'kind' => $kind])
        ->assertUnprocessable();

    expect(Channel::where('name', $name)->exists())->toBeFalse();
})->with([
    'uppercase' => ['General2', 'public'],
    'leading dash' => ['-oops', 'public'],
    'space' => ['two words', 'public'],
    'too long' => [str_repeat('a', 41), 'public'],
    'empty' => ['', 'public'],
    'dm kind' => ['dm-room', 'dm'],
]);

test('join is idempotent and limited to public channels', function () {
    $owner = User::factory()->create();
    $user = User::factory()->create();
    $public = publicChannel($owner);

    asUser($user)->postJson("/api/v1/channels/{$public->id}/join")->assertOk()->assertJson(['is_member' => true]);
    asUser($user)->postJson("/api/v1/channels/{$public->id}/join")->assertOk();
    expect($public->members()->whereKey($user->id)->count())->toBe(1);

    // A member of a private channel still cannot "join" it: membership is by invitation.
    $private = privateChannel($owner);
    $private->members()->attach($user->id);
    asUser($user)->postJson("/api/v1/channels/{$private->id}/join")->assertForbidden();
});

test('banned user cannot join', function () {
    $banned = User::factory()->banned()->create();
    $channel = publicChannel(User::factory()->create());

    asUser($banned)->postJson("/api/v1/channels/{$channel->id}/join")
        ->assertForbidden()->assertExactJson(['error' => 'account_banned']);

    expect($channel->members()->whereKey($banned->id)->exists())->toBeFalse();
});

test('member can leave but the sole owner cannot', function () {
    Event::fake([MemberRemoved::class]);
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($member->id);

    asUser($owner)->postJson("/api/v1/channels/{$channel->id}/leave")
        ->assertUnprocessable()->assertExactJson(['error' => 'sole_owner']);
    asUser($owner)->deleteJson("/api/v1/channels/{$channel->id}/members/{$owner->id}")
        ->assertUnprocessable()->assertExactJson(['error' => 'sole_owner']);
    expect($channel->members()->whereKey($owner->id)->exists())->toBeTrue();
    Event::assertNotDispatched(MemberRemoved::class);

    asUser($member)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNoContent();
    expect($channel->members()->whereKey($member->id)->exists())->toBeFalse();
    Event::assertDispatched(MemberRemoved::class, fn ($e) => $e->user->is($member));

    // Leaving a channel you are not in is a no-op.
    asUser($member)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNoContent();
    Event::assertDispatchedTimes(MemberRemoved::class, 1);
});

test('an owner can leave once another owner exists', function () {
    $owner = User::factory()->create();
    $second = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach($second->id, ['role' => 'owner']);

    asUser($owner)->postJson("/api/v1/channels/{$channel->id}/leave")->assertNoContent();

    expect($channel->members()->pluck('users.id')->all())->toBe([$second->id]);
});

test('a member can remove themselves but not others', function () {
    $owner = User::factory()->create();
    $a = User::factory()->create();
    $b = User::factory()->create();
    $channel = publicChannel($owner);
    $channel->members()->attach([$a->id, $b->id]);

    asUser($a)->deleteJson("/api/v1/channels/{$channel->id}/members/{$b->id}")->assertForbidden();
    asUser($a)->deleteJson("/api/v1/channels/{$channel->id}/members/{$a->id}")->assertNoContent();

    expect($channel->members()->pluck('users.id')->sort()->values()->all())->toBe(collect([$owner->id, $b->id])->sort()->values()->all());
});

test('adding an existing member never changes their role', function () {
    $owner = User::factory()->create();
    $channel = publicChannel($owner);

    asUser($owner)->postJson("/api/v1/channels/{$channel->id}/members", ['user_id' => $owner->id])
        ->assertOk()->assertJson(['role' => 'owner']);

    asUser($owner)->postJson("/api/v1/channels/{$channel->id}/members", ['user_id' => 999999])
        ->assertUnprocessable()->assertJsonValidationErrors('user_id');
});
