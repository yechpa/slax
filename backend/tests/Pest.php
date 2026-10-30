<?php

use App\Models\Channel;
use App\Models\User;
use Illuminate\Broadcasting\BroadcastManager;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/*
|--------------------------------------------------------------------------
| Test Case
|--------------------------------------------------------------------------
|
| Feature tests boot the Laravel application on a real PostgreSQL database
| that is rolled back between tests; Unit tests stay framework-free.
|
*/

pest()->extend(TestCase::class)->use(RefreshDatabase::class)->in('Feature');

/*
|--------------------------------------------------------------------------
| Shared helpers (Feature tests seed the default workspace first)
|--------------------------------------------------------------------------
*/

/** Same-origin SPA call, authenticated by the session cookie. */
function asUser(User $user): TestCase
{
    return test()->withHeaders(['Referer' => 'http://localhost/'])->actingAs($user);
}

function privateChannel(User $owner, string $name = 'secret'): Channel
{
    $channel = Channel::factory()->private()->create(['name' => $name]);
    $channel->members()->attach($owner->id, ['role' => 'owner']);

    return $channel;
}

function publicChannel(User $owner, string $name = 'team'): Channel
{
    $channel = Channel::factory()->create(['name' => $name]);
    $channel->members()->attach($owner->id, ['role' => 'owner']);

    return $channel;
}

/** Channel callbacks live on the driver instance: register them again on the fresh Reverb one. */
function useReverbDriver(): void
{
    config(['broadcasting.default' => 'reverb']);
    app(BroadcastManager::class)->purge('reverb');
    require base_path('routes/channels.php');
}

/** POST /broadcasting/auth for any channel name, e.g. `private-channel.3` or `presence-workspace.1`. */
function authorizeChannelName(User $user, string $channelName, string $socketId = '1234.5678'): TestResponse
{
    return asUser($user)->postJson('/broadcasting/auth', [
        'socket_id' => $socketId,
        'channel_name' => $channelName,
    ]);
}

function authorizeChannel(User $user, int $channelId, string $socketId = '1234.5678'): TestResponse
{
    return authorizeChannelName($user, "private-channel.{$channelId}", $socketId);
}
