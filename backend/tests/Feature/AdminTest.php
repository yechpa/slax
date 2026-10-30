<?php

use App\Contracts\AdminNotifier;
use App\Events\MessageDeleted;
use App\Events\MessageUpdated;
use App\Models\AuditLog;
use App\Models\Channel;
use App\Models\File;
use App\Models\Message;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\PresenceService;
use App\Services\UserSessions;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Routing\Route as RoutingRoute;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\Support\RecordingNotifier;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
    expect((int) config('database.redis.default.database'))->toBe(15);
    Redis::connection()->flushdb();
    $this->notifier = new RecordingNotifier;
    app()->instance(AdminNotifier::class, $this->notifier);
});

function admin(): User
{
    return User::factory()->admin()->create(['name' => 'Ada Admin']);
}

/** @return list<RoutingRoute> */
function adminRoutes(): array
{
    return array_values(array_filter(
        Route::getRoutes()->getRoutes(),
        fn (RoutingRoute $route) => str_starts_with($route->uri(), 'api/v1/admin'),
    ));
}

/** A route's URI with every parameter replaced by an id that exists. */
function adminUri(RoutingRoute $route, int $id): string
{
    return '/'.preg_replace('/\{[^}]+\}/', (string) $id, $route->uri());
}

test('non_admin_gets_403_on_every_admin_route', function () {
    $routes = adminRoutes();
    // Ban, unban list, message, file, lock, audit, status: a new route is covered automatically.
    expect(count($routes))->toBeGreaterThanOrEqual(7);

    $member = User::factory()->create();
    $target = User::factory()->create();
    $channel = publicChannel($member);
    $message = Message::factory()->create(['channel_id' => $channel->id, 'user_id' => $member->id]);
    storedFile($member, $channel, ['message_id' => $message->id]);
    Storage::fake('s3');

    foreach ($routes as $route) {
        // Every admin route is behind the `admin` gate, whatever its controller does.
        expect($route->gatherMiddleware())->toContain('can:admin');

        foreach ($route->methods() as $method) {
            if ($method === 'HEAD') {
                continue;
            }
            // Ids that exist, so a 403 is the gate and not a missing record; banned or not, a member is refused.
            foreach ([$target->id, $message->id] as $id) {
                asUser($member)->json($method, adminUri($route, $id), ['banned' => true, 'locked' => true])
                    ->assertForbidden();
            }
            app('auth')->forgetGuards();
            test()->withHeaders(['Referer' => 'http://localhost/'])->json($method, adminUri($route, $target->id))->assertUnauthorized();
        }
    }

    expect($target->fresh()->isBanned())->toBeFalse()
        ->and($message->fresh()->isDeleted())->toBeFalse()
        ->and($channel->fresh()->isLocked())->toBeFalse()
        ->and(File::count())->toBe(1);
});

test('a banned administrator is refused too', function () {
    $admin = User::factory()->admin()->banned()->create();

    asUser($admin)->getJson('/api/v1/admin/status')->assertForbidden()->assertExactJson(['error' => 'account_banned']);
});

test('ban_logs_audit_and_kills_sessions_and_sockets', function () {
    fakeReverb();
    fakeTerminations();
    $admin = admin();
    $target = User::factory()->create();
    $bystander = User::factory()->create();

    // Two live sessions of the target in the session store, indexed at sign-in.
    $handler = app('session')->driver()->getHandler();
    foreach (['session-one', 'session-two', 'bystander-session'] as $id) {
        $handler->write($id, serialize(['login_web_x' => $target->id]));
    }
    app(UserSessions::class)->remember($target, 'session-one');
    app(UserSessions::class)->remember($target, 'session-two');
    app(UserSessions::class)->remember($bystander, 'bystander-session');
    app(PresenceService::class)->heartbeat($target->id, true);

    asUser($admin)->postJson("/api/v1/admin/users/{$target->id}/ban")
        ->assertOk()
        ->assertJson(['id' => $target->id, 'banned' => true]);

    expect($target->fresh()->isBanned())->toBeTrue()
        // Sessions gone from the store (the bystander's untouched)...
        ->and($handler->read('session-one'))->toBe('')
        ->and($handler->read('session-two'))->toBe('')
        ->and($handler->read('bystander-session'))->not->toBe('')
        // ...presence cleared...
        ->and(app(PresenceService::class)->stateOf($target->id))->toBe('offline')
        ->and(Redis::connection()->exists("presence:{$target->id}"))->toBe(0)
        // ...and the user's sockets closed by Reverb.
        ->and(terminationPaths())->toBe(["/apps/test-app/users/{$target->id}/terminate_connections"]);

    $audit = AuditLog::sole();
    expect($audit->action)->toBe('user.banned')
        ->and($audit->actor_id)->toBe($admin->id)
        ->and($audit->target_type)->toBe('user')
        ->and($audit->target_id)->toBe($target->id)
        ->and($audit->ip)->toBe('127.0.0.1');

    $alerts = $this->notifier->withTitle('user.banned');
    expect($alerts)->toHaveCount(1)
        ->and($alerts[0]['context'])->toMatchArray(['target_id' => $target->id, 'actor_id' => $admin->id])
        ->and(json_encode($this->notifier->alerts))->not->toContain($target->email)->not->toContain($target->name);

    // The banned user is refused everywhere, even with a session still in hand.
    app('auth')->forgetGuards();
    asUser($target->fresh())->getJson('/api/v1/channels')->assertForbidden()->assertExactJson(['error' => 'account_banned']);
    authorizeChannelName($target->fresh(), 'presence-workspace.1')->assertForbidden();
});

test('banning twice is idempotent and audited once; unbanning lifts it', function () {
    fakeTerminations();
    $admin = admin();
    $target = User::factory()->create();

    asUser($admin)->postJson("/api/v1/admin/users/{$target->id}/ban")->assertOk();
    asUser($admin)->postJson("/api/v1/admin/users/{$target->id}/ban", ['banned' => true])->assertOk();
    expect(AuditLog::where('action', 'user.banned')->count())->toBe(1);

    asUser($admin)->getJson('/api/v1/admin/users/banned')
        ->assertOk()
        ->assertJsonPath('data.0.id', $target->id)
        ->assertJsonMissingPath('data.0.email');

    asUser($admin)->postJson("/api/v1/admin/users/{$target->id}/ban", ['banned' => false])
        ->assertOk()->assertJson(['banned' => false]);
    expect($target->fresh()->isBanned())->toBeFalse()
        ->and(AuditLog::where('action', 'user.unbanned')->count())->toBe(1);
});

test('an administrator cannot ban an administrator or themselves', function () {
    $admin = admin();
    $other = admin();

    asUser($admin)->postJson("/api/v1/admin/users/{$admin->id}/ban")->assertUnprocessable()->assertExactJson(['error' => 'cannot_ban_admin']);
    asUser($admin)->postJson("/api/v1/admin/users/{$other->id}/ban")->assertUnprocessable();
    asUser($admin)->postJson('/api/v1/admin/users/999999/ban')->assertNotFound();
    asUser($admin)->postJson("/api/v1/admin/users/{$other->id}/ban", ['banned' => 'yes'])->assertUnprocessable();

    expect($other->fresh()->isBanned())->toBeFalse()->and(AuditLog::count())->toBe(0);
});

test('moderated message delete leaves a tombstone, removes its files object first, and is audited', function () {
    Storage::fake('s3');
    Event::fake([MessageDeleted::class]);
    $admin = admin();
    $author = User::factory()->create();
    $channel = publicChannel($author);
    $message = Message::factory()->create(['channel_id' => $channel->id, 'user_id' => $author->id, 'body' => 'a very private body']);
    $file = storedFile($author, $channel, ['message_id' => $message->id, 'size' => 1000]);
    Storage::disk('s3')->put($file->storage_key, 'hello');
    expect(File::usedBytes($author))->toBe(1000);

    asUser($admin)->deleteJson("/api/v1/admin/messages/{$message->id}")
        ->assertOk()
        ->assertJson(['id' => $message->id, 'deleted' => true])
        ->assertJsonMissingPath('body');

    expect($message->fresh()->isDeleted())->toBeTrue()
        ->and(File::count())->toBe(0)
        ->and(File::usedBytes($author))->toBe(0);
    Storage::disk('s3')->assertMissing($file->storage_key);
    Event::assertDispatched(MessageDeleted::class);

    $audit = AuditLog::sole();
    expect($audit->action)->toBe('message.moderated_delete')
        ->and($audit->target_id)->toBe($message->id)
        ->and(json_encode($audit->toArray()))->not->toContain('private body');
    expect($this->notifier->withTitle('message.moderated_delete'))->toHaveCount(1)
        ->and(json_encode($this->notifier->alerts))->not->toContain('private body');

    // Idempotent.
    asUser($admin)->deleteJson("/api/v1/admin/messages/{$message->id}")->assertOk();
    expect(AuditLog::count())->toBe(1);
});

test('when object storage refuses, the file row stays and the delete can be retried', function () {
    Storage::fake('s3');
    $admin = admin();
    $author = User::factory()->create();
    $channel = publicChannel($author);
    $message = Message::factory()->create(['channel_id' => $channel->id, 'user_id' => $author->id]);
    $file = storedFile($author, $channel, ['message_id' => $message->id]);

    $disk = Mockery::mock(Storage::disk('s3'))->makePartial();
    $disk->shouldReceive('delete')->andReturnFalse();
    Storage::set('s3', $disk);

    asUser($admin)->deleteJson("/api/v1/admin/messages/{$message->id}")
        ->assertStatus(503)->assertExactJson(['error' => 'storage_unavailable']);
    // The message is a tombstone already; its file is kept (attached, hidden) for the retry.
    expect($message->fresh()->isDeleted())->toBeTrue()
        ->and($file->fresh())->not->toBeNull()
        ->and($file->fresh()->message_id)->toBe($message->id);

    asUser($admin)->deleteJson("/api/v1/admin/files/{$file->id}")->assertStatus(503);
    expect($file->fresh())->not->toBeNull();

    Storage::fake('s3');
    asUser($admin)->deleteJson("/api/v1/admin/messages/{$message->id}")->assertOk();
    expect(File::count())->toBe(0);
});

test('moderated file delete removes the object then the row and updates the message', function () {
    Storage::fake('s3');
    Event::fake([MessageUpdated::class, MessageDeleted::class]);
    $admin = admin();
    $author = User::factory()->create();
    $channel = publicChannel($author);
    $message = Message::factory()->create(['channel_id' => $channel->id, 'user_id' => $author->id, 'body' => 'look']);
    $kept = storedFile($author, $channel, ['message_id' => $message->id]);
    $removed = storedFile($author, $channel, ['message_id' => $message->id]);
    Storage::disk('s3')->put($kept->storage_key, 'a');
    Storage::disk('s3')->put($removed->storage_key, 'b');

    asUser($admin)->deleteJson("/api/v1/admin/files/{$removed->id}")->assertNoContent();

    Storage::disk('s3')->assertMissing($removed->storage_key);
    Storage::disk('s3')->assertExists($kept->storage_key);
    expect(File::pluck('id')->all())->toBe([$kept->id])
        ->and(AuditLog::sole())->action->toBe('file.moderated_delete')->target_id->toBe($removed->id);
    Event::assertDispatched(MessageUpdated::class);

    // A message left with neither body nor file becomes a tombstone.
    $bare = Message::factory()->create(['channel_id' => $channel->id, 'user_id' => $author->id, 'body' => '']);
    $only = storedFile($author, $channel, ['message_id' => $bare->id]);
    asUser($admin)->deleteJson("/api/v1/admin/files/{$only->id}")->assertNoContent();
    expect($bare->fresh()->isDeleted())->toBeTrue();
    Event::assertDispatched(MessageDeleted::class);

    asUser($admin)->deleteJson('/api/v1/admin/files/999999')->assertNotFound();
});

test('a locked channel is read-only for members, admins still post and moderate, and the lock lifts', function () {
    $admin = admin();
    $member = User::factory()->create();
    $channel = publicChannel($member);
    $channel->addMember($admin);
    $message = Message::factory()->create(['channel_id' => $channel->id, 'user_id' => $member->id]);

    asUser($admin)->postJson("/api/v1/admin/channels/{$channel->id}/lock")
        ->assertOk()->assertJson(['id' => $channel->id, 'locked' => true]);
    // Idempotent: locking a locked channel changes nothing and is not audited again.
    asUser($admin)->postJson("/api/v1/admin/channels/{$channel->id}/lock", ['locked' => true])->assertOk();
    expect(AuditLog::where('action', 'channel.locked')->count())->toBe(1)
        ->and($this->notifier->withTitle('channel.locked'))->toHaveCount(1);

    app('auth')->forgetGuards();
    asUser($member)->getJson("/api/v1/channels/{$channel->id}")->assertOk()->assertJson(['locked' => true]);
    asUser($member)->getJson("/api/v1/channels/{$channel->id}/messages")->assertOk();
    asUser($member)->postJson("/api/v1/channels/{$channel->id}/messages", ['body' => 'hi', 'client_id' => (string) Str::uuid()])
        ->assertForbidden()->assertExactJson(['error' => 'channel_locked']);
    asUser($member)->patchJson("/api/v1/messages/{$message->id}", ['body' => 'edited'])
        ->assertForbidden()->assertExactJson(['error' => 'channel_locked']);
    asUser($member)->putJson("/api/v1/messages/{$message->id}/reactions/".rawurlencode('👍'))
        ->assertForbidden()->assertExactJson(['error' => 'channel_locked']);
    asUser($member)->postJson('/api/v1/files', ['file' => uploadedFile('a.txt', 'hello', 'text/plain'), 'channel_id' => $channel->id])
        ->assertForbidden();
    // The refused send is audited.
    expect(AuditLog::where('action', 'message.send_refused')->where('target_id', $channel->id)->where('actor_id', $member->id)->count())->toBe(1);

    app('auth')->forgetGuards();
    asUser($admin)->postJson("/api/v1/channels/{$channel->id}/messages", ['body' => 'Locked for cleanup', 'client_id' => (string) Str::uuid()])
        ->assertCreated();

    asUser($admin)->postJson("/api/v1/admin/channels/{$channel->id}/lock", ['locked' => false])
        ->assertOk()->assertJson(['locked' => false]);
    expect(AuditLog::where('action', 'channel.unlocked')->count())->toBe(1);

    app('auth')->forgetGuards();
    asUser($member)->postJson("/api/v1/channels/{$channel->id}/messages", ['body' => 'back', 'client_id' => (string) Str::uuid()])
        ->assertCreated();
});

test('admins can lock a private channel they are not in, and conversations are not channels to lock', function () {
    $admin = admin();
    $owner = User::factory()->create();
    $private = privateChannel($owner);
    $dm = Channel::factory()->dm()->create();

    asUser($admin)->postJson("/api/v1/admin/channels/{$private->id}/lock")->assertOk();
    asUser($admin)->postJson("/api/v1/admin/channels/{$dm->id}/lock")->assertNotFound();
    asUser($admin)->postJson('/api/v1/admin/channels/999999/lock')->assertNotFound();
});

test('the audit log is paginated newest first, with ids and display names but no e-mail address', function () {
    $admin = admin();
    $target = User::factory()->create(['name' => 'Target Person', 'email' => 'target@example.com']);
    fakeTerminations();

    asUser($admin)->postJson("/api/v1/admin/users/{$target->id}/ban")->assertOk();
    asUser($admin)->postJson("/api/v1/admin/users/{$target->id}/ban", ['banned' => false])->assertOk();
    foreach (range(1, 3) as $_) {
        app(AuditLogger::class)->record('auth.sign_in_failed.invalid_state');
    }

    $page = asUser($admin)->getJson('/api/v1/admin/audit?per_page=2')->assertOk();
    $page->assertJsonCount(2, 'data')->assertJsonPath('has_more', true)->assertJsonPath('page', 1);
    expect($page->json('data.0.action'))->toBe('auth.sign_in_failed.invalid_state');

    $last = asUser($admin)->getJson('/api/v1/admin/audit?per_page=2&page=3')->assertOk();
    $last->assertJsonCount(1, 'data')->assertJsonPath('has_more', false)
        ->assertJsonPath('data.0.action', 'user.banned')
        ->assertJsonPath('data.0.actor.id', $admin->id)
        ->assertJsonPath('data.0.actor.name', 'Ada Admin')
        ->assertJsonPath('data.0.target.type', 'user')
        ->assertJsonPath('data.0.target.id', $target->id)
        ->assertJsonPath('data.0.target.label', 'Target Person');

    $all = asUser($admin)->getJson('/api/v1/admin/audit?per_page=100')->assertOk()->getContent();
    expect($all)->not->toContain('@example.com');

    asUser($admin)->getJson('/api/v1/admin/audit?per_page=500')->assertUnprocessable();
});

test('the status page reports every service with its latency and never fails', function () {
    Storage::fake('s3');
    config([
        'services.scanner.url' => 'http://scanner.test:8000',
        'broadcasting.connections.reverb.options' => ['host' => 'reverb.test', 'port' => 8080, 'scheme' => 'http'],
    ]);
    Http::fake([
        'scanner.test:8000/health' => Http::response(['status' => 'ok']),
        'reverb.test:8080/up' => Http::response('', 500),
    ]);

    $status = asUser(admin())->getJson('/api/v1/admin/status')->assertOk();

    $services = collect($status->json('services'))->keyBy('name');
    expect($services->keys()->sort()->values()->all())->toBe(['database', 'redis', 'reverb', 's3', 'scanner'])
        ->and($services['database']['status'])->toBe('ok')
        ->and($services['redis']['status'])->toBe('ok')
        ->and($services['scanner']['status'])->toBe('ok')
        ->and($services['s3']['status'])->toBe('ok')
        ->and($services['reverb']['status'])->toBe('degraded')
        ->and($services['database']['latency_ms'])->toBeInt();
    expect($status->getContent())->not->toContain((string) config('database.connections.pgsql.password'));

    config(['services.scanner.url' => 'http://scanner-down.test:8000']);
    Http::fake(['scanner-down.test:8000/*' => fn () => throw new ConnectionException('down')]);
    $status = asUser(admin())->getJson('/api/v1/admin/status')->assertOk();
    expect(collect($status->json('services'))->keyBy('name')['scanner']['status'])->toBe('degraded');
});

test('admin writes are rate limited', function () {
    $admin = admin();
    $channel = publicChannel($admin);

    foreach (range(1, 30) as $i) {
        asUser($admin)->postJson("/api/v1/admin/channels/{$channel->id}/lock", ['locked' => $i % 2 === 0])->assertOk();
    }
    asUser($admin)->postJson("/api/v1/admin/channels/{$channel->id}/lock")->assertTooManyRequests();
});

test('banned people are cut off from the cheap places they still reached', function () {
    $owner = User::factory()->create();
    $friend = User::factory()->create();
    $banned = User::factory()->banned()->create();
    $channel = publicChannel($owner);
    $channel->addMember($banned);
    $dm = Channel::factory()->dm()->create();
    $dm->members()->attach([$friend->id, $banned->id]);

    // Owners cannot add a banned account.
    asUser($owner)->postJson("/api/v1/channels/{$channel->id}/members", ['user_id' => $banned->id])->assertUnprocessable();
    // Member lists leave banned accounts out.
    expect(collect(asUser($owner)->getJson("/api/v1/channels/{$channel->id}/members")->json())->pluck('id')->all())
        ->toBe([$owner->id]);
    // A one-to-one conversation with a banned person is no longer listed.
    app('auth')->forgetGuards();
    expect(collect(asUser($friend)->getJson('/api/v1/channels')->json())->pluck('id')->all())->not->toContain($dm->id);
});

test('with Redis unreachable a ban still stands, is audited and closes the sockets', function () {
    fakeReverb();
    fakeTerminations();
    $admin = admin();
    $target = User::factory()->create();
    config(['database.redis.default.port' => 1, 'database.redis.default.timeout' => 0.2, 'database.redis.default.read_timeout' => 0.2]);
    app('redis')->purge();

    asUser($admin)->postJson("/api/v1/admin/users/{$target->id}/ban")->assertOk();

    expect($target->fresh()->isBanned())->toBeTrue()
        ->and(AuditLog::where('action', 'user.banned')->where('target_id', $target->id)->count())->toBe(1)
        ->and(terminationPaths())->toBe(["/apps/test-app/users/{$target->id}/terminate_connections"]);
});

test('with neither Reverb nor the queue reachable a ban still stands and is audited and alerted', function () {
    fakeReverb();
    // Reverb refuses, and the retry job (sync queue in tests) fails too.
    fakeTerminations(fn () => throw new Illuminate\Http\Client\ConnectionException('down'));
    $admin = admin();
    $target = User::factory()->create();

    asUser($admin)->postJson("/api/v1/admin/users/{$target->id}/ban")->assertOk();

    expect($target->fresh()->isBanned())->toBeTrue()
        ->and(AuditLog::where('action', 'user.banned')->count())->toBe(1)
        ->and($this->notifier->withTitle('user.banned'))->toHaveCount(1);
});

test('an account whose address is in ADMIN_EMAILS cannot be banned, flag or not', function () {
    config(['slax.admin_emails' => ['boss@example.com']]);
    $listed = User::factory()->create(['email' => 'Boss@Example.com', 'is_admin' => false]);

    asUser(admin())->postJson("/api/v1/admin/users/{$listed->id}/ban")
        ->assertUnprocessable()->assertExactJson(['error' => 'cannot_ban_admin']);
    expect($listed->fresh()->isBanned())->toBeFalse();
});
