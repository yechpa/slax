<?php

use App\Services\Turnstile;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    config(['services.turnstile.secret' => 'test-secret']);
});

test('real turnstile posts the secret, token and ip to cloudflare', function () {
    Http::fake(['challenges.cloudflare.com/*' => Http::response(['success' => true])]);

    expect((new Turnstile)->verify('tok', '203.0.113.9'))->toBeTrue();

    Http::assertSent(fn (Request $r) => $r->url() === 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
        && $r['secret'] === 'test-secret' && $r['response'] === 'tok' && $r['remoteip'] === '203.0.113.9');
});

test('real turnstile refuses on failure, error status or network error', function () {
    Http::fakeSequence()
        ->push(['success' => false, 'error-codes' => ['invalid-input-response']])
        ->push('nope', 500)
        ->pushFailedConnection();

    expect((new Turnstile)->verify('tok', '1.1.1.1'))->toBeFalse()
        ->and((new Turnstile)->verify('tok', '1.1.1.1'))->toBeFalse()
        ->and((new Turnstile)->verify('tok', '1.1.1.1'))->toBeFalse();
});

test('real turnstile refuses an empty token without calling cloudflare', function () {
    Http::fake();

    expect((new Turnstile)->verify('', '1.1.1.1'))->toBeFalse();
    Http::assertNothingSent();
});
