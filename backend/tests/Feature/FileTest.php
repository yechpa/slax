<?php

use App\Exceptions\ScannerUnavailable;
use App\Exceptions\StorageUnavailable;
use App\Models\File;
use App\Models\User;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Exceptions;
use Illuminate\Support\Facades\Storage;

const MB = 1024 * 1024;

beforeEach(function () {
    $this->seed(DefaultWorkspaceSeeder::class);
    Storage::fake('s3');
});

// --- Upload ---------------------------------------------------------------------------

test('an upload is scanned, then stored under a uuid key', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);

    $response = uploadTo($user, $channel, uploadedFile('pixel.png', pngBytes(), 'image/png'))
        ->assertCreated()
        ->assertJson(['name' => 'pixel.png', 'mime' => 'image/png', 'size' => strlen(pngBytes()), 'kind' => 'image']);

    $file = File::sole();
    expect($response->json('id'))->toBe($file->id)
        ->and($response->json('download_url'))->toBe("/api/v1/files/{$file->id}/download")
        ->and($file->storage_key)->toMatch('#^files/\d{4}/\d{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$#')
        ->and($file->storage_key)->toStartWith('files/'.now()->format('Y/m').'/')
        ->and($file->user_id)->toBe($user->id)
        ->and($file->channel_id)->toBe($channel->id)
        ->and($file->message_id)->toBeNull()
        ->and($file->sha256)->toBe(hash('sha256', pngBytes()))
        ->and($file->scan_status)->toBe(File::STATUS_CLEAN);
    expect(Storage::disk('s3')->get($file->storage_key))->toBe(pngBytes());
    expect(scanner()->calls)->toBe(1);
});

test('upload_fails_closed_when_scanner_down', function () {
    Exceptions::fake();
    scanner()->down = true;
    $user = User::factory()->create();

    uploadTo($user, publicChannel($user), uploadedFile('pixel.png', pngBytes()))
        ->assertStatus(503)
        ->assertExactJson(['error' => 'scanner_unavailable']);

    expect(File::count())->toBe(0)
        ->and(Storage::disk('s3')->allFiles())->toBe([]);
    // Outages are reported (logged); rejections are expected outcomes and are not.
    Exceptions::assertReported(ScannerUnavailable::class);
});

test('a file the scanner refuses is rejected with its reason and nothing is stored', function () {
    scanner()->rejectWith = 'extension_mismatch';
    $user = User::factory()->create();

    uploadTo($user, publicChannel($user), uploadedFile('photo.png', 'not a png'))
        ->assertUnprocessable()
        ->assertExactJson(['error' => 'file_rejected', 'reason' => 'extension_mismatch']);

    expect(File::count())->toBe(0)->and(Storage::disk('s3')->allFiles())->toBe([]);
});

test('a zero byte file is rejected before scanning', function () {
    $user = User::factory()->create();

    uploadTo($user, publicChannel($user), uploadedFile('empty.txt', ''))
        ->assertUnprocessable()
        ->assertExactJson(['error' => 'file_rejected', 'reason' => 'empty_file']);

    expect(scanner()->calls)->toBe(0)->and(File::count())->toBe(0);
});

test('more than 10 MB is rejected by the API even if the scanner would accept it', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);

    $tenMegabytes = str_repeat("line\n", 2 * MB);
    uploadTo($user, $channel, uploadedFile('big.txt', $tenMegabytes.'x'))
        ->assertUnprocessable()
        ->assertExactJson(['error' => 'file_rejected', 'reason' => 'too_large']);
    expect(scanner()->calls)->toBe(0)->and(File::count())->toBe(0);

    // The size measured is that of the bytes received, not a declared one: exactly 10 MB passes.
    uploadTo($user, $channel, uploadedFile('limit.txt', $tenMegabytes))->assertCreated();
    expect(File::sole()->size)->toBe(10 * MB);
});

test('the stored type is the detected one, never the type the client declared', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);

    uploadTo($user, $channel, uploadedFile('pixel.png', pngBytes(), 'text/html'))
        ->assertCreated()->assertJson(['mime' => 'image/png']);
    expect(File::sole()->mime)->toBe('image/png');

    // Whatever the scanner says, only the allowed types are ever stored.
    scanner()->mime = 'text/html';
    uploadTo($user, $channel, uploadedFile('page.txt', '<html></html>', 'text/plain'))
        ->assertUnprocessable()->assertExactJson(['error' => 'file_rejected', 'reason' => 'type_not_allowed']);
    expect(File::count())->toBe(1);
});

test('filename_is_sanitized_rtl_controls_and_traversal', function (string $clientName, string $content, string $expected) {
    $user = User::factory()->create();

    uploadTo($user, publicChannel($user), uploadedFile($clientName, $content))
        ->assertCreated()
        ->assertJson(['name' => $expected]);

    $file = File::sole();
    expect($file->display_name)->toBe($expected)
        ->and(mb_strlen($file->display_name))->toBeLessThanOrEqual(120)
        // The client's name never reaches the storage key.
        ->and($file->storage_key)->toMatch('#^files/\d{4}/\d{2}/[0-9a-f-]{36}$#');
})->with([
    'path traversal' => ['../../etc/passwd', "root:x:0:0\n", 'passwd.txt'],
    'windows path' => ['C:\\Users\\me\\..\\pixel.png', pngBytes(), 'pixel.png'],
    'right-to-left override (spoofed exe.png)' => ["a\u{202E}gnp.exe", pngBytes(), 'agnp.exe.png'],
    'bidi embeddings and isolates' => ["\u{202A}x\u{202B}y\u{202C}z\u{202D}\u{2066}w\u{2067}\u{2068}\u{2069}.png", pngBytes(), 'xyzw.png'],
    'zero width and bom' => ["re\u{200B}po\u{200C}rt\u{200D}\u{FEFF}.txt", 'hello', 'report.txt'],
    'nul byte' => ["\u{0000}x.png", pngBytes(), 'x.png'],
    'other control characters' => ["a\u{0007}b\u{007F}c\u{009B}.txt", 'hello', 'abc.txt'],
    'whitespace collapsed' => ["  my \t\n  notes\u{00A0}\u{2028} file .txt  ", 'hello', 'my notes file .txt'],
    'leading dots' => ['..hidden.txt', 'hello', 'hidden.txt'],
    'dots only' => ['...', 'hello', 'file.txt'],
    'nothing left' => ["\u{202E}\u{200B}/", pngBytes(), 'file.png'],
    'no extension' => ['notes', 'hello', 'notes.txt'],
    'extension of another type' => ['page.html', 'hello', 'page.html.txt'],
    'known extension kept in its case' => ['PIXEL.PNG', pngBytes(), 'PIXEL.PNG'],
    'jpeg alias' => ['pixel.jpeg', pngBytes(), 'pixel.jpeg.png'],
    'hebrew' => ['דוח שנתי.txt', 'שלום', 'דוח שנתי.txt'],
    'hebrew with RLM and LRM kept' => ["\u{200F}דוח\u{200E} 2026.txt", 'hello', "\u{200F}דוח\u{200E} 2026.txt"],
    'decomposed accents are composed (NFC)' => ["cafe\u{0301}.txt", 'hello', "caf\u{00E9}.txt"],
    'very long ascii' => [str_repeat('a', 300).'.png', pngBytes(), str_repeat('a', 116).'.png'],
    'very long hebrew' => [str_repeat('א', 300).'.txt', 'hello', str_repeat('א', 116).'.txt'],
    'very long without extension' => [str_repeat('b', 300), 'hello', str_repeat('b', 116).'.txt'],
    'long name cut before trailing dots' => [str_repeat('c', 115).'.....x.txt', 'hello', str_repeat('c', 115).'.txt'],
]);

test('account_quota_100mb_enforced', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    foreach (range(1, 9) as $_) {
        storedFile($user, $channel, ['size' => 10 * MB]);
    }
    storedFile($user, $channel, ['size' => 5 * MB]);
    // Someone else's files do not count.
    $other = User::factory()->create();
    storedFile($other, $channel, ['size' => 10 * MB]);

    uploadTo($user, $channel, uploadedFile('six.txt', str_repeat('a', 5 * MB + 1)))
        ->assertUnprocessable()
        ->assertExactJson(['error' => 'file_rejected', 'reason' => 'quota_exceeded']);
    expect(scanner()->calls)->toBe(0);

    // Up to exactly 100 MB.
    uploadTo($user, $channel, uploadedFile('five.txt', str_repeat('a', 5 * MB)))->assertCreated();
    uploadTo($user, $channel, uploadedFile('one.txt', 'a'))
        ->assertUnprocessable()->assertJson(['reason' => 'quota_exceeded']);

    expect(File::usedBytes($user))->toBe(100 * MB)
        ->and(Storage::disk('s3')->allFiles())->toHaveCount(1);
});

test('account_quota_100mb_enforced atomically: of two uploads that only fit one at a time, the second is refused', function () {
    $user = User::factory()->create();
    $channel = publicChannel($user);
    foreach (range(1, 9) as $_) {
        storedFile($user, $channel, ['size' => 10 * MB]);
    }

    // Upload B passes the early quota check, then upload A reserves its 6 MB while B is being scanned.
    scanner()->whileScanning = function () use ($user, $channel) {
        scanner()->whileScanning = null;
        storedFile($user, $channel, ['size' => 6 * MB, 'display_name' => 'a.txt']);
    };
    $queries = [];
    DB::listen(function (QueryExecuted $query) use (&$queries) {
        $queries[] = [strtolower($query->sql), DB::transactionLevel()];
    });

    uploadTo($user, $channel, uploadedFile('b.txt', str_repeat('b', 6 * MB)))
        ->assertUnprocessable()
        ->assertExactJson(['error' => 'file_rejected', 'reason' => 'quota_exceeded']);

    expect(File::where('user_id', $user->id)->where('display_name', '!=', 'file.txt')->pluck('display_name')->all())->toBe(['a.txt'])
        ->and(Storage::disk('s3')->allFiles())->toBe([]);

    // The decisive check runs after the scan, on the locked account row, and reserves in the same transaction.
    $queries = collect($queries);
    $early = $queries->search(fn ($q) => str_contains($q[0], 'sum("size")'));
    $lock = $queries->search(fn ($q) => str_contains($q[0], 'from "users"') && str_contains($q[0], 'for update'));
    $locked = $queries->search(fn ($q, $i) => $i > $lock && str_contains($q[0], 'sum("size")'));
    expect($early)->not->toBeFalse()->and($lock)->toBeGreaterThan($early)->and($locked)->not->toBeFalse()
        ->and($queries[$lock][1])->toBe($queries[$early][1] + 1)
        ->and($queries[$locked][1])->toBe($queries[$lock][1]);

    // Without the concurrent upload, B fits: the reservation is an insert in that same transaction.
    $queries = [];
    File::where('display_name', 'a.txt')->delete();
    uploadTo($user, $channel, uploadedFile('b.txt', str_repeat('b', 6 * MB)))->assertCreated();
    $queries = collect($queries);
    $lock = $queries->search(fn ($q) => str_contains($q[0], 'for update'));
    $insert = $queries->search(fn ($q) => str_starts_with($q[0], 'insert into "files"'));
    expect($insert)->toBeGreaterThan($lock)->and($queries[$insert][1])->toBe($queries[$lock][1]);
});

test('uploading needs the right to post in the channel', function () {
    $owner = User::factory()->create();
    $outsider = User::factory()->create();
    $png = fn () => uploadedFile('pixel.png', pngBytes());

    uploadTo($outsider, privateChannel($owner), $png())->assertNotFound();
    uploadTo($outsider, publicChannel($owner), $png())->assertForbidden();
    asUser($outsider)->postJson('/api/v1/files', ['file' => $png(), 'channel_id' => 999999])->assertNotFound();
    asUser($outsider)->postJson('/api/v1/files', ['channel_id' => publicChannel($outsider, 'mine')->id])
        ->assertUnprocessable()->assertJsonValidationErrors('file');
    asUser($outsider)->postJson('/api/v1/files', ['file' => $png()])
        ->assertUnprocessable()->assertJsonValidationErrors('channel_id');

    expect(scanner()->calls)->toBe(0)->and(File::count())->toBe(0);
});

test('uploads are rate limited per user', function () {
    $user = User::factory()->create();

    foreach (range(1, 20) as $_) {
        asUser($user)->postJson('/api/v1/files', [])->assertUnprocessable();
    }
    asUser($user)->postJson('/api/v1/files', [])->assertTooManyRequests();
    asUser(User::factory()->create())->postJson('/api/v1/files', [])->assertUnprocessable();
});

test('a failed object write leaves no row behind', function () {
    Exceptions::fake();
    $disk = Mockery::mock(Filesystem::class);
    $disk->shouldReceive('put')->once()->andReturn(false);
    $disk->shouldReceive('delete')->once()->andReturn(true);
    Storage::set('s3', $disk);
    $user = User::factory()->create();

    uploadTo($user, publicChannel($user), uploadedFile('pixel.png', pngBytes()))
        ->assertStatus(503)
        ->assertExactJson(['error' => 'storage_unavailable']);

    expect(File::count())->toBe(0);
    Exceptions::assertReported(StorageUnavailable::class);
});

test('a database failure after the object write removes the object', function () {
    File::saving(function (File $file) {
        if ($file->scan_status === File::STATUS_CLEAN) {
            throw new RuntimeException('database went away');
        }
    });
    $user = User::factory()->create();

    $this->withoutExceptionHandling();
    expect(fn () => uploadTo($user, publicChannel($user), uploadedFile('pixel.png', pngBytes())))
        ->toThrow(RuntimeException::class, 'database went away');

    expect(Storage::disk('s3')->allFiles())->toBe([])->and(File::count())->toBe(0);
});
