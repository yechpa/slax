<?php

use App\Models\Channel;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
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
