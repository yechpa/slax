<?php

use App\Events\MessageCreated;
use App\Events\MessageDeleted;
use App\Models\Channel;
use App\Models\File;
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

function postWithFiles(User $user, Channel $channel, mixed $fileIds, array $data = []): TestResponse
{
    return asUser($user)->postJson("/api/v1/channels/{$channel->id}/messages", $data + [
        'body' => 'see attached',
        'client_id' => (string) Str::uuid(),
        'file_ids' => $fileIds,
    ]);
}

test('a message can carry only files', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $pdf = storedFile($user, $channel, ['display_name' => 'רפורט.pdf', 'mime' => 'application/pdf', 'size' => 1234]);
    $png = storedFile($user, $channel, ['display_name' => 'pixel.png', 'mime' => 'image/png']);
    $zip = storedFile($user, $channel, ['display_name' => 'bundle.zip', 'mime' => 'application/zip']);

    $response = postWithFiles($user, $channel, [$png->id, $pdf->id], ['body' => " \n "])
        ->assertCreated()
        ->assertJson(['body' => '', 'files' => [
            ['id' => $pdf->id, 'name' => 'רפורט.pdf', 'mime' => 'application/pdf', 'size' => 1234, 'kind' => 'pdf', 'download_url' => "/api/v1/files/{$pdf->id}/download"],
            ['id' => $png->id, 'name' => 'pixel.png', 'mime' => 'image/png', 'kind' => 'image'],
        ]]);
    expect($response->json('files'))->toHaveCount(2)
        ->and($pdf->fresh()->message_id)->toBe($response->json('id'))
        ->and($png->fresh()->message_id)->toBe($response->json('id'));

    // No body at all is fine too, with files.
    postWithFiles($user, $channel, [$zip->id], ['body' => null])
        ->assertCreated()->assertJson(['body' => '', 'files' => [['id' => $zip->id, 'kind' => 'other']]]);

    // Listings render the files as well; messages without any have an empty list.
    $listed = asUser($user)->getJson("/api/v1/channels/{$channel->id}/messages")->assertOk()->json('data');
    expect(array_column($listed[0]['files'], 'id'))->toBe([$pdf->id, $png->id])
        ->and($listed[1]['files'][0]['id'])->toBe($zip->id);
    postWithFiles($user, $channel, [])->assertCreated()->assertJson(['files' => []]);
});

test('a body is still required without files', function (array $data) {
    $user = User::factory()->create();
    $channel = publicChannel($user);

    asUser($user)->postJson("/api/v1/channels/{$channel->id}/messages", $data + ['client_id' => (string) Str::uuid()])
        ->assertUnprocessable()->assertJsonValidationErrors('body');

    expect(Message::count())->toBe(0);
})->with([
    'blank body, no files' => [['body' => '  ']],
    'blank body, empty file list' => [['body' => '', 'file_ids' => []]],
    'no body, empty file list' => [['file_ids' => []]],
]);

test('the body limit still applies with files', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $file = storedFile($user, $channel);

    postWithFiles($user, $channel, [$file->id], ['body' => str_repeat('א', 4001)])
        ->assertUnprocessable()->assertJsonValidationErrors('body');
    expect($file->fresh()->message_id)->toBeNull();
});

test('file_ids must be the poster\'s own recent, unattached uploads to this channel', function (Closure $makeIds, string $error) {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $other = User::factory()->create();
    $channel->members()->attach($other->id);
    $ids = $makeIds($user, $other, $channel);
    $attachments = fn () => File::orderBy('id')->pluck('message_id', 'id')->all();
    $before = $attachments();

    postWithFiles($user, $channel, $ids)
        ->assertUnprocessable()->assertJsonValidationErrors($error);

    expect(Message::where('user_id', $user->id)->count())->toBe(0)
        ->and($attachments())->toBe($before);
})->with([
    'someone else\'s file' => [fn ($user, $other, $channel) => [storedFile($other, $channel)->id], 'file_ids'],
    'a file uploaded to another channel' => [fn ($user, $other, $channel) => [storedFile($user, publicChannel($user, 'elsewhere'))->id], 'file_ids'],
    'an already attached file' => [fn ($user, $other, $channel) => [storedFile($user, $channel, [
        'message_id' => Message::factory()->create(['channel_id' => $channel->id, 'user_id' => $other->id])->id,
    ])->id], 'file_ids'],
    'an expired upload' => [fn ($user, $other, $channel) => [storedFile($user, $channel, ['created_at' => now()->subHours(24)->subSecond()])->id], 'file_ids'],
    'an unfinished upload' => [fn ($user, $other, $channel) => [storedFile($user, $channel, ['scan_status' => File::STATUS_PENDING])->id], 'file_ids'],
    'an unknown file' => [fn () => [999999], 'file_ids'],
    'one good, one bad' => [fn ($user, $other, $channel) => [storedFile($user, $channel)->id, storedFile($other, $channel)->id], 'file_ids'],
    'more than 10 files' => [fn ($user, $other, $channel) => File::factory()->count(11)->create(['user_id' => $user->id, 'channel_id' => $channel->id])->modelKeys(), 'file_ids'],
    'the same file twice' => [fn ($user, $other, $channel) => array_fill(0, 2, storedFile($user, $channel)->id), 'file_ids.0'],
    'not an integer' => [fn () => ['x'], 'file_ids.0'],
    'not a list' => [fn () => 'abc', 'file_ids'],
]);

test('ten files are allowed', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $ids = File::factory()->count(10)->create(['user_id' => $user->id, 'channel_id' => $channel->id])->modelKeys();

    postWithFiles($user, $channel, $ids)->assertCreated()->assertJsonCount(10, 'files');
});

test('a file attached concurrently makes the whole message fail', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $free = storedFile($user, $channel);
    $raced = storedFile($user, $channel);
    $elsewhere = Message::factory()->create(['channel_id' => $channel->id, 'user_id' => $user->id]);
    // Another request attaches $raced after this one validated file_ids, just as the message is inserted.
    DB::listen(function (QueryExecuted $query) use ($raced, $elsewhere) {
        static $done = false;
        if (! $done && str_starts_with(strtolower($query->sql), 'insert into messages')) {
            $done = true;
            DB::table('files')->where('id', $raced->id)->update(['message_id' => $elsewhere->id]);
        }
    });

    postWithFiles($user, $channel, [$free->id, $raced->id])
        ->assertUnprocessable()->assertJsonValidationErrors('file_ids');

    expect(Message::count())->toBe(1)->and($free->fresh()->message_id)->toBeNull();
});

test('a replay of the same client_id does not attach again', function () {
    Event::fake([MessageCreated::class]);
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $first = storedFile($user, $channel);
    $second = storedFile($user, $channel);
    $clientId = (string) Str::uuid();

    $created = postWithFiles($user, $channel, [$first->id], ['client_id' => $clientId])->assertCreated();
    postWithFiles($user, $channel, [$first->id, $second->id], ['client_id' => $clientId])
        ->assertOk()
        ->assertJson(['id' => $created->json('id')])
        ->assertJsonCount(1, 'files');

    expect($second->fresh()->message_id)->toBeNull()
        ->and(Message::count())->toBe(1);
    Event::assertDispatchedTimes(MessageCreated::class, 1);
});

test('broadcast payloads include the files, tombstones do not', function () {
    Event::fake([MessageCreated::class, MessageDeleted::class]);
    $user = User::factory()->create();
    $channel = publicChannel($user);
    $file = storedFile($user, $channel, ['display_name' => 'pixel.png', 'mime' => 'image/png', 'size' => 70]);

    $id = postWithFiles($user, $channel, [$file->id])->assertCreated()->json('id');

    $payload = Event::dispatched(MessageCreated::class)->sole()[0]->broadcastWith();
    expect($payload['files'])->toBe([[
        'id' => $file->id,
        'name' => 'pixel.png',
        'mime' => 'image/png',
        'size' => 70,
        'kind' => 'image',
        'download_url' => "/api/v1/files/{$file->id}/download",
    ]]);

    $deleted = asUser($user)->deleteJson("/api/v1/messages/{$id}")->assertOk()->json();
    expect($deleted)->not->toHaveKey('files')
        ->and(Event::dispatched(MessageDeleted::class)->sole()[0]->broadcastWith())->not->toHaveKey('files');
});
