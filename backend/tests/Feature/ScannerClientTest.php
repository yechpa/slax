<?php

use App\Exceptions\ScannerUnavailable;
use App\Models\File;
use App\Models\User;
use App\Services\ScannerClient;
use Database\Seeders\DefaultWorkspaceSeeder;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Exceptions;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;

/** The real HTTP client (tests otherwise get FakeScannerClient), against a faked scanner. */
function httpScanner(): ScannerClient
{
    return new ScannerClient('http://scanner.test');
}

function verdict(array $overrides = []): array
{
    return $overrides + ['ok' => true, 'reason' => null, 'sha256' => hash('sha256', pngBytes()), 'detected_mime' => 'image/png'];
}

test('the scanner client sends the bytes as multipart, under a neutral name, with a 5 second timeout', function () {
    $sent = null;
    Http::fake(function (Request $request, array $options) use (&$sent) {
        $sent = ['request' => $request, 'body' => (string) $request->toPsrRequest()->getBody(), 'options' => $options];

        return Http::response(verdict());
    });

    $result = httpScanner()->scan(uploadedFile("../evil\u{202E}\"\r\nX: y.PNG", pngBytes()));

    expect($result->ok)->toBeTrue()
        ->and($result->reason)->toBeNull()
        ->and($result->sha256)->toBe(hash('sha256', pngBytes()))
        ->and($result->detectedMime)->toBe('image/png');

    ['request' => $request, 'body' => $body] = $sent;
    expect($request->method())->toBe('POST')
        ->and($request->url())->toBe('http://scanner.test/scan')
        ->and($request->hasFile('file', null, 'upload.png'))->toBeTrue()
        // Only the extension of the sanitized name travels: no quotes or line breaks in the part headers.
        ->and($body)->toContain('filename="upload.png"')
        ->and($body)->not->toContain('evil')
        ->and($body)->toContain(pngBytes())
        ->and($sent['options']['timeout'])->toBe(5)
        ->and($sent['options']['connect_timeout'])->toBeLessThanOrEqual(5);
});

test('a name without a usable extension is sent as plain upload', function () {
    $sent = null;
    Http::fake(function (Request $request) use (&$sent) {
        $sent = (string) $request->toPsrRequest()->getBody();

        return Http::response(verdict());
    });

    httpScanner()->scan(uploadedFile('notes', 'hello'));

    expect($sent)->toContain('filename="upload"');
});

test('a refusal comes back with its reason', function () {
    Http::fake(['scanner.test/scan' => Http::response(verdict(['ok' => false, 'reason' => 'zip_unsafe_path', 'detected_mime' => 'application/zip']))]);

    $result = httpScanner()->scan(uploadedFile('bundle.zip', 'PK'));

    expect($result->ok)->toBeFalse()->and($result->reason)->toBe('zip_unsafe_path');
});

test('the scanner is unavailable on any transport or protocol failure', function ($respond) {
    Http::preventStrayRequests();
    Http::fake(['scanner.test/*' => $respond]);

    expect(fn () => httpScanner()->scan(uploadedFile('pixel.png', pngBytes())))
        ->toThrow(ScannerUnavailable::class);
})->with([
    'connection refused or timeout' => [fn () => fn () => throw new ConnectionException('cURL error 28: Operation timed out')],
    'server error' => [fn () => Http::response(verdict(), 500)],
    'not found' => [fn () => Http::response('', 404)],
    'redirect' => [fn () => Http::response('', 302, ['Location' => 'http://elsewhere.test/'])],
    'not json' => [fn () => Http::response('<html>proxy error</html>', 200)],
    'json list' => [fn () => Http::response([1, 2], 200)],
    'missing fields' => [fn () => Http::response(['ok' => true], 200)],
    'ok is not a boolean' => [fn () => Http::response(verdict(['ok' => 'true']), 200)],
    'ok without a valid sha256' => [fn () => Http::response(verdict(['sha256' => 'abc']), 200)],
    'ok without a type' => [fn () => Http::response(verdict(['detected_mime' => '']), 200)],
    'refusal without a reason' => [fn () => Http::response(verdict(['ok' => false, 'reason' => null]), 200)],
    'refusal with a malformed reason' => [fn () => Http::response(verdict(['ok' => false, 'reason' => '<b>no</b>']), 200)],
]);

test('an upload fails closed when the real scanner times out', function () {
    $this->seed(DefaultWorkspaceSeeder::class);
    Exceptions::fake();
    Storage::fake('s3');
    app()->instance(ScannerClient::class, httpScanner());
    Http::fake(['scanner.test/*' => fn () => throw new ConnectionException('cURL error 28: Operation timed out')]);
    $user = User::factory()->create();

    uploadTo($user, publicChannel($user), uploadedFile('pixel.png', pngBytes()))
        ->assertStatus(503)
        ->assertExactJson(['error' => 'scanner_unavailable']);

    expect(File::count())->toBe(0)->and(Storage::disk('s3')->allFiles())->toBe([]);
    Exceptions::assertReported(ScannerUnavailable::class);
});
