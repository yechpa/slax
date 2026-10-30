<?php

use App\Contracts\AdminNotifier;
use App\Models\AuditLog;
use App\Models\Channel;
use App\Models\File;
use App\Models\Message;
use App\Models\Reaction;
use App\Models\User;
use App\Services\UserSessions;
use Database\Seeders\DefaultWorkspaceSeeder;
use Database\Seeders\DemoSeeder;
use Illuminate\Console\Scheduling\Event as ScheduledEvent;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Facades\Storage;
use Tests\Support\RecordingNotifier;

beforeEach(function () {
    $this->seed(DemoSeeder::class);
    expect((int) config('database.redis.default.database'))->toBe(15);
    Redis::connection()->flushdb();
    Storage::fake('s3');
    $this->notifier = new RecordingNotifier;
    app()->instance(AdminNotifier::class, $this->notifier);
});

function starter(string $name): Channel
{
    return Channel::where('name', $name)->whereIn('kind', ['public', 'private'])->sole();
}

function seedMessage(string $key): Message
{
    return Message::where('client_id', DemoSeeder::clientId($key))->sole();
}

/** A file of $user in $channel with its object in the (faked) bucket. */
function fileWithObject(User $user, Channel $channel, ?Message $message = null): File
{
    $file = storedFile($user, $channel, ['message_id' => $message?->id]);
    Storage::disk('s3')->put($file->storage_key, 'bytes');

    return $file;
}

/** Everything a visitor can leave behind, in a starter channel, a channel of theirs and a conversation. */
function visitorActivity(User $visitor, User $other): array
{
    $general = starter('general');
    $general->addMember($visitor);
    $post = Message::factory()->create(['channel_id' => $general->id, 'user_id' => $visitor->id]);
    $reply = Message::factory()->create(['channel_id' => $general->id, 'user_id' => $visitor->id, 'parent_id' => seedMessage('general.welcome')->id]);
    Reaction::create(['message_id' => seedMessage('general.shalom')->id, 'user_id' => $visitor->id, 'emoji' => '🔥']);
    $file = fileWithObject($visitor, $general, $post);

    $own = publicChannel($visitor, 'visitor-room-'.$visitor->id);
    $own->forceFill(['created_by' => $visitor->id])->save();
    $ownFile = fileWithObject($visitor, $own, Message::factory()->create(['channel_id' => $own->id, 'user_id' => $visitor->id]));

    $dm = Channel::factory()->dm()->create();
    $dm->members()->attach([$visitor->id, $other->id]);
    Message::factory()->create(['channel_id' => $dm->id, 'user_id' => $other->id]);

    return compact('post', 'reply', 'file', 'own', 'ownFile', 'dm');
}

test('the demo seed is multilingual, with a thread and reactions, by seed accounts only', function () {
    $people = User::where('account_type', User::ACCOUNT_SEED)->get();
    expect($people)->toHaveCount(count(DemoSeeder::PEOPLE))
        ->and($people->every(fn (User $user) => str_ends_with($user->email, '@seed.slax.invalid') && ! $user->is_admin))->toBeTrue();

    $bodies = Message::pluck('body')->implode("\n");
    expect($bodies)->toMatch('/\p{Hebrew}/u')->toContain('Bonjour')->toContain('Welcome');
    expect(seedMessage('general.welcome')->replies()->count())->toBe(3)
        ->and(seedMessage('general.welcome')->reactions()->count())->toBe(3);

    foreach (array_keys(DefaultWorkspaceSeeder::CHANNELS) as $name) {
        expect(Message::where('channel_id', starter($name)->id)->count())->toBeGreaterThan(0);
    }
});

test('demo_reset_keeps_accounts_active_within_7_days', function () {
    fakeReverb();
    fakeTerminations();
    $active = User::factory()->demo(daysAgo: 6)->create();
    $expired = User::factory()->demo(daysAgo: 8)->create();
    $neverSeen = User::factory()->demo()->create(['last_seen_at' => null, 'created_at' => now()->subDays(9)]);
    $newcomer = User::factory()->demo()->create(['last_seen_at' => null, 'created_at' => now()->subDay()]);
    // Accounts that are not visitors' never expire, however quiet.
    $member = User::factory()->create(['last_seen_at' => now()->subYear()]);

    $expiredActivity = visitorActivity($expired, $active);
    $activeActivity = visitorActivity($active, $member);

    $handler = app('session')->driver()->getHandler();
    $handler->write('expired-session', 'data');
    app(UserSessions::class)->remember($expired, 'expired-session');

    $this->artisan('slax:demo-reset')->assertSuccessful();

    expect(User::find($expired->id))->toBeNull()
        ->and(User::find($neverSeen->id))->toBeNull()
        ->and(User::find($active->id))->not->toBeNull()
        ->and(User::find($newcomer->id))->not->toBeNull()
        ->and(User::find($member->id))->not->toBeNull()
        ->and(User::where('account_type', User::ACCOUNT_SEED)->count())->toBe(count(DemoSeeder::PEOPLE));

    // The expired account's objects went before its rows; nothing of either visitor is left.
    foreach ([$expiredActivity, $activeActivity] as $activity) {
        Storage::disk('s3')->assertMissing($activity['file']->storage_key);
        Storage::disk('s3')->assertMissing($activity['ownFile']->storage_key);
        expect(Channel::find($activity['own']->id))->toBeNull()
            ->and(Channel::find($activity['dm']->id))->toBeNull()
            ->and(Message::find($activity['post']->id))->toBeNull()
            ->and(Message::find($activity['reply']->id))->toBeNull();
    }
    expect(File::count())->toBe(0)
        // The active visitor is still a member of the starter channel.
        ->and(starter('general')->hasMember($active))->toBeTrue();

    // The deleted account's sessions and sockets are gone too.
    expect($handler->read('expired-session'))->toBe('')
        ->and(terminationPaths())->toContain("/apps/test-app/users/{$expired->id}/terminate_connections");

    expect(AuditLog::where('action', 'demo.reset')->count())->toBe(1);
    $summary = $this->notifier->withTitle('Demo reset');
    expect($summary)->toHaveCount(1)
        ->and($summary[0]['level'])->toBe('info')
        ->and($summary[0]['context'])->toMatchArray(['deleted_users' => 2, 'failed_files' => 0]);
});

test('demo_reset_restores_seed_channels_and_messages', function () {
    fakeTerminations();
    $admin = User::factory()->admin()->create();
    $visitor = User::factory()->demo()->create();
    $activity = visitorActivity($visitor, User::factory()->demo()->create());

    // The seed, tampered with: an edit, a moderated delete, a lost reaction, a new topic.
    seedMessage('general.bonjour')->forceFill(['body' => 'vandalised', 'edited_at' => now()])->save();
    seedMessage('random.coffee')->forceFill(['deleted_at' => now()])->save();
    Reaction::where('message_id', seedMessage('general.welcome')->id)->delete();
    starter('general')->forceFill(['topic' => 'changed'])->save();
    // An administrator's own post is not demo content.
    $announcement = Message::factory()->create(['channel_id' => starter('general')->id, 'user_id' => $admin->id, 'body' => 'Maintenance tonight']);
    $adminRoom = publicChannel($admin, 'admin-room');
    $adminRoom->forceFill(['created_by' => $admin->id])->save();

    $before = fn () => [
        'messages' => Message::orderBy('id')->get(['id', 'channel_id', 'user_id', 'parent_id', 'body', 'edited_at', 'deleted_at'])->toArray(),
        'reactions' => Reaction::orderBy('message_id')->orderBy('emoji')->orderBy('user_id')->get(['message_id', 'user_id', 'emoji'])->toArray(),
        'channels' => Channel::orderBy('id')->get(['id', 'name', 'topic'])->toArray(),
    ];

    $this->artisan('slax:demo-reset')->assertSuccessful();
    $afterFirst = $before();

    expect(seedMessage('general.bonjour'))->body->toBe(collect(DemoSeeder::MESSAGES)->firstWhere('key', 'general.bonjour')['body'])
        ->edited_at->toBeNull()
        ->and(seedMessage('random.coffee')->deleted_at)->toBeNull()
        ->and(starter('general')->topic)->toBe(DefaultWorkspaceSeeder::CHANNELS['general'])
        ->and(seedMessage('general.welcome')->replies()->count())->toBe(3)
        ->and(Message::find($activity['reply']->id))->toBeNull()
        ->and(Message::find($announcement->id))->not->toBeNull()
        ->and(Channel::find($adminRoom->id))->not->toBeNull()
        ->and(Channel::find($activity['own']->id))->toBeNull();

    // Exactly the seed reactions on seed messages: the visitor's is gone, the lost ones are back.
    $reactions = Reaction::with('message', 'user')->get()
        ->map(fn (Reaction $reaction) => $reaction->emoji.' '.$reaction->user->google_sub)->sort()->values()->all();
    $expected = collect(DemoSeeder::REACTIONS)->map(fn (array $reaction) => $reaction['emoji'].' '.DemoSeeder::SUB_PREFIX.$reaction['by'])->sort()->values()->all();
    expect($reactions)->toBe($expected);

    // Seed messages only, plus the administrator's.
    expect(Message::count())->toBe(count(DemoSeeder::MESSAGES) + 1);

    // Safe to run twice: nothing changes the second time.
    $this->artisan('slax:demo-reset')->assertSuccessful();
    expect($before())->toEqual($afterFirst);
});

test('demo_reset_never_deletes_admin', function () {
    fakeTerminations();
    config(['slax.admin_emails' => ['boss@example.com']]);
    $admin = User::factory()->admin()->create(['last_seen_at' => now()->subYear(), 'created_at' => now()->subYear()]);
    // Even marked as a demo account by mistake: an administrator flag or address protects it.
    $flagged = User::factory()->admin()->demo(daysAgo: 60)->create();
    $listed = User::factory()->demo(daysAgo: 60)->create(['email' => 'Boss@Example.com']);
    $post = Message::factory()->create(['channel_id' => starter('general')->id, 'user_id' => $flagged->id]);
    $file = fileWithObject($admin, starter('general'), $post);

    $this->artisan('slax:demo-reset')->assertSuccessful();
    $this->artisan('slax:demo-reset')->assertSuccessful();

    expect(User::find($admin->id))->not->toBeNull()
        ->and(User::find($flagged->id))->not->toBeNull()
        ->and(User::find($listed->id))->not->toBeNull()
        ->and(Message::find($post->id))->not->toBeNull()
        ->and(File::find($file->id))->not->toBeNull();
    Storage::disk('s3')->assertExists($file->storage_key);
});

test('when object storage refuses, the account and its rows wait for the next run', function () {
    fakeTerminations();
    $expired = User::factory()->demo(daysAgo: 30)->create();
    $general = starter('general');
    $file = fileWithObject($expired, $general, Message::factory()->create(['channel_id' => $general->id, 'user_id' => $expired->id]));

    $disk = Mockery::mock(Storage::disk('s3'))->makePartial();
    $disk->shouldReceive('delete')->andReturnFalse();
    Storage::set('s3', $disk);

    $this->artisan('slax:demo-reset')->assertFailed();

    // Nothing points at a missing object, nothing in the bucket is forgotten.
    expect(User::find($expired->id))->not->toBeNull()
        ->and(File::find($file->id))->not->toBeNull()
        ->and($this->notifier->withTitle('Demo reset'))->toHaveCount(1)
        ->and($this->notifier->withTitle('Demo reset')[0])->level->toBe('warning');

    Storage::set('s3', Storage::fake('s3'));
    $this->artisan('slax:demo-reset')->assertSuccessful();
    expect(User::find($expired->id))->toBeNull()->and(File::find($file->id))->toBeNull();
});

test('the reset is scheduled daily at 03:00 Jerusalem time', function () {
    $events = collect(app(Schedule::class)->events())
        ->filter(fn (ScheduledEvent $event) => str_contains((string) $event->command, 'slax:demo-reset'));

    expect($events)->toHaveCount(1);
    $event = $events->first();
    expect($event->expression)->toBe('0 3 * * *')
        ->and((string) $event->timezone)->toBe('Asia/Jerusalem')
        ->and($event->withoutOverlapping)->toBeTrue();
});
