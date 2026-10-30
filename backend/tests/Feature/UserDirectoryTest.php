<?php

use App\Models\Channel;
use App\Models\User;
use App\Models\Workspace;
use Database\Seeders\DefaultWorkspaceSeeder;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
});

function searchUsers(User $caller, array $query)
{
    return asUser($caller)->getJson('/api/v1/users?'.http_build_query($query));
}

test('user_search_matches_names_case_insensitively_without_emails', function () {
    $caller = User::factory()->create(['name' => 'Alice Martin']);
    $dana = User::factory()->create(['name' => 'Dana Levi', 'email' => 'dana@example.test', 'avatar_url' => 'https://example.test/d.png']);
    $daniel = User::factory()->create(['name' => 'daniel', 'email' => 'daniel@example.test']);
    User::factory()->create(['name' => 'Noam']);

    $response = searchUsers($caller, ['q' => 'DAN'])->assertOk();

    expect($response->json())->toBe([
        ['id' => $dana->id, 'name' => 'Dana Levi', 'avatar_url' => 'https://example.test/d.png'],
        ['id' => $daniel->id, 'name' => 'daniel', 'avatar_url' => null],
    ]);
    // Nothing but these three fields, ever.
    expect($response->getContent())->not->toContain('@example.test')
        ->and($response->getContent())->not->toContain('locale')
        ->and($response->getContent())->not->toContain('is_admin');
});

test('user_search_matches_hebrew_names_and_the_middle_of_a_name', function () {
    $caller = User::factory()->create(['name' => 'Alice']);
    $noam = User::factory()->create(['name' => 'נעם כהן']);
    User::factory()->create(['name' => 'Dana']);

    expect(searchUsers($caller, ['q' => 'כהן'])->assertOk()->json('*.id'))->toBe([$noam->id]);
});

test('user_search_excludes_banned_users_and_the_caller', function () {
    $caller = User::factory()->create(['name' => 'Sam One']);
    $other = User::factory()->create(['name' => 'Sam Two']);
    User::factory()->banned()->create(['name' => 'Sam Banned']);

    expect(searchUsers($caller, ['q' => 'sam'])->assertOk()->json('*.id'))->toBe([$other->id]);
});

test('user_search_escapes_like_wildcards', function () {
    $caller = User::factory()->create(['name' => 'Caller']);
    $percent = User::factory()->create(['name' => '100% Dana']);
    $underscore = User::factory()->create(['name' => 'dana_ops']);
    $backslash = User::factory()->create(['name' => 'back\\slash']);
    User::factory()->create(['name' => 'Dana Levi']);
    User::factory()->create(['name' => 'danaXops']);

    expect(searchUsers($caller, ['q' => '%'])->assertOk()->json('*.id'))->toBe([$percent->id])
        ->and(searchUsers($caller, ['q' => '_'])->assertOk()->json('*.id'))->toBe([$underscore->id])
        ->and(searchUsers($caller, ['q' => 'a_o'])->assertOk()->json('*.id'))->toBe([$underscore->id])
        ->and(searchUsers($caller, ['q' => '\\'])->assertOk()->json('*.id'))->toBe([$backslash->id]);
});

test('user_search_is_ordered_by_name_then_id_and_capped_at_20', function () {
    $caller = User::factory()->create(['name' => 'Caller']);
    $ids = [];
    foreach (range(1, 25) as $i) {
        $ids[] = User::factory()->create(['name' => sprintf('Tester %02d', 26 - $i)])->id;
    }
    $twin = User::factory()->create(['name' => 'Tester 01'])->id;

    $all = searchUsers($caller, ['q' => 'tester'])->assertOk()->json();
    expect($all)->toHaveCount(20)
        ->and(array_column($all, 'name'))->toBe(array_merge(['Tester 01', 'Tester 01'], array_map(fn ($n) => sprintf('Tester %02d', $n), range(2, 19))))
        // Same name: by id.
        ->and([$all[0]['id'], $all[1]['id']])->toBe([$ids[24], $twin]);

    expect(searchUsers($caller, ['q' => 'tester', 'limit' => 3])->assertOk()->json())->toHaveCount(3);
    searchUsers($caller, ['q' => 'tester', 'limit' => 21])->assertUnprocessable()->assertJsonValidationErrors('limit');
    searchUsers($caller, ['q' => 'tester', 'limit' => 0])->assertUnprocessable()->assertJsonValidationErrors('limit');
});

test('user_search_needs_a_query_of_1_to_50_characters', function () {
    $caller = User::factory()->create();

    searchUsers($caller, [])->assertUnprocessable()->assertJsonValidationErrors('q');
    searchUsers($caller, ['q' => '   '])->assertUnprocessable()->assertJsonValidationErrors('q');
    searchUsers($caller, ['q' => str_repeat('a', 51)])->assertUnprocessable()->assertJsonValidationErrors('q');
    searchUsers($caller, ['q' => str_repeat('א', 50)])->assertOk()->assertExactJson([]);
    searchUsers($caller, ['q' => ['a']])->assertUnprocessable()->assertJsonValidationErrors('q');
});

test('user_search_is_for_signed_in_non_banned_users_and_rate_limited', function () {
    test()->getJson('/api/v1/users?q=a')->assertUnauthorized();
    asUser(User::factory()->banned()->create())->getJson('/api/v1/users?q=a')->assertForbidden();

    $caller = User::factory()->create();
    foreach (range(1, 60) as $_) {
        searchUsers($caller, ['q' => 'a'])->assertOk();
    }
    searchUsers($caller, ['q' => 'a'])->assertTooManyRequests();
});

test('channel_members_lists_owners_first_then_by_name_without_emails', function () {
    $owner = User::factory()->create(['name' => 'Zed Owner']);
    $amy = User::factory()->create(['name' => 'amy', 'email' => 'amy@example.test']);
    $bob = User::factory()->create(['name' => 'Bob']);
    $channel = privateChannel($owner);
    $channel->members()->attach([$bob->id, $amy->id]);

    $response = asUser($bob)->getJson("/api/v1/channels/{$channel->id}/members")->assertOk();

    expect($response->json())->toBe([
        ['id' => $owner->id, 'name' => 'Zed Owner', 'avatar_url' => null, 'role' => 'owner'],
        ['id' => $amy->id, 'name' => 'amy', 'avatar_url' => null, 'role' => 'member'],
        ['id' => $bob->id, 'name' => 'Bob', 'avatar_url' => null, 'role' => 'member'],
    ]);
    expect($response->getContent())->not->toContain('@example.test');
});

test('channel_members_of_a_public_channel_are_visible_to_anyone_private_and_dm_to_members_only', function () {
    $owner = User::factory()->create();
    $outsider = User::factory()->create();
    $public = publicChannel($owner);
    $private = privateChannel($owner);
    $dm = Channel::factory()->create(['kind' => Channel::KIND_DM, 'name' => null, 'dm_key' => "dm:{$owner->id},999"]);
    $dm->members()->attach($owner->id);

    // Guests first (acting as a user sticks for the rest of the test).
    test()->getJson("/api/v1/channels/{$public->id}/members")->assertUnauthorized();
    asUser($outsider)->getJson("/api/v1/channels/{$public->id}/members")->assertOk()->assertJsonPath('0.id', $owner->id);
    asUser($outsider)->getJson("/api/v1/channels/{$private->id}/members")->assertNotFound();
    asUser($outsider)->getJson("/api/v1/channels/{$dm->id}/members")->assertNotFound();
    asUser($outsider)->getJson('/api/v1/channels/999999/members')->assertNotFound();
    asUser($owner)->getJson("/api/v1/channels/{$dm->id}/members")->assertOk()->assertJsonPath('0.id', $owner->id);
});

test('channel_members_are_capped_at_200', function () {
    $owner = User::factory()->create(['name' => 'Owner']);
    $channel = publicChannel($owner);
    $channel->members()->attach(User::factory()->count(205)->create()->modelKeys());

    $members = asUser($owner)->getJson("/api/v1/channels/{$channel->id}/members")->assertOk()->json();
    expect($members)->toHaveCount(200)->and($members[0]['role'])->toBe('owner');
});

test('me_tells_the_workspace_id_for_the_presence_channel', function () {
    $user = User::factory()->create();

    asUser($user)->getJson('/api/v1/me')->assertOk()->assertJsonPath('workspace_id', Workspace::default()->id);
});
