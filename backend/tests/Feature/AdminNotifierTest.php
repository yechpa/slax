<?php

use App\Contracts\AdminNotifier;
use App\Services\Alerts\NotifierFactory;
use App\Services\Alerts\NullNotifier;
use App\Services\Alerts\TelegramNotifier;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Redis;
use Tests\Support\RecordingNotifier;

// Obviously fake credentials: real ones only ever come from the environment.
const FAKE_BOT_TOKEN = '123:TEST';
const FAKE_CHAT_ID = '-100999';

beforeEach(function () {
    // REDIS_DB=15 under phpunit.xml: never the development data.
    expect((int) config('database.redis.default.database'))->toBe(15);
    Redis::connection()->flushdb();
    $this->withoutDefer();
});

function telegram(string $label = 'Dev'): TelegramNotifier
{
    config(['slax.alerts.env_label' => $label]);

    return new TelegramNotifier(FAKE_BOT_TOKEN, FAKE_CHAT_ID, app('redis'));
}

/** @return list<string> texts sent to the Bot API */
function sentTexts(): array
{
    return Http::recorded()->map(fn ($pair) => (string) $pair[0]['text'])->values()->all();
}

test('the testing environment binds the null notifier', function () {
    expect(app(AdminNotifier::class))->toBeInstanceOf(NullNotifier::class);
});

test('telegram is bound only when both the token and the chat id are configured', function () {
    $resolve = function (?string $token, ?string $chat) {
        config(['services.telegram.bot_token' => $token, 'services.telegram.chat_id' => $chat]);

        return NotifierFactory::make('production');
    };

    expect($resolve(null, null))->toBeInstanceOf(NullNotifier::class)
        ->and($resolve(FAKE_BOT_TOKEN, ''))->toBeInstanceOf(NullNotifier::class)
        ->and($resolve('', FAKE_CHAT_ID))->toBeInstanceOf(NullNotifier::class)
        ->and($resolve(FAKE_BOT_TOKEN, FAKE_CHAT_ID))->toBeInstanceOf(TelegramNotifier::class)
        // Tests never reach Telegram, configured or not.
        ->and(NotifierFactory::make('testing'))->toBeInstanceOf(NullNotifier::class);
});

test('an alert is posted to the Bot API with the environment prefix', function () {
    Http::fake(['api.telegram.org/*' => Http::response(['ok' => true])]);

    telegram('Prod')->notify('error', 'Queue stalled', ['count' => 3]);

    Http::assertSentCount(1);
    Http::assertSent(fn (Request $request) => $request->url() === 'https://api.telegram.org/bot'.FAKE_BOT_TOKEN.'/sendMessage'
        && $request['chat_id'] === FAKE_CHAT_ID
        && str_starts_with($request['text'], '[Prod] ')
        && str_contains($request['text'], 'Queue stalled')
        && str_contains($request['text'], 'count: 3'));
});

test('the environment label defaults to Dev', function () {
    Http::fake(['api.telegram.org/*' => Http::response(['ok' => true])]);
    config(['slax.alerts.env_label' => null]);

    (new TelegramNotifier(FAKE_BOT_TOKEN, FAKE_CHAT_ID, app('redis')))->notify('info', 'Hello');

    expect(sentTexts()[0])->toStartWith('[Dev] ');
});

test('unknown levels are refused', function (AdminNotifier $notifier) {
    Http::fake();

    expect(fn () => $notifier->notify('debug', 'Nope'))->toThrow(InvalidArgumentException::class);
    Http::assertNothingSent();
})->with([
    'telegram' => fn () => telegram(),
    'null' => fn () => new NullNotifier,
]);

test('notifier_dedupes_identical_alerts_for_5_minutes', function () {
    Http::fake(['api.telegram.org/*' => Http::response(['ok' => true])]);
    $notifier = telegram();

    $notifier->notify('warning', 'Scanner unreachable', ['service' => 'scanner']);
    $notifier->notify('warning', 'Scanner unreachable', ['service' => 'scanner']);
    $this->travel(4)->minutes();
    $notifier->notify('warning', 'Scanner unreachable', ['service' => 'scanner']);

    // A different alert is not a duplicate.
    $notifier->notify('warning', 'Scanner unreachable', ['service' => 's3']);
    $notifier->notify('error', 'Scanner unreachable', ['service' => 'scanner']);
    expect(sentTexts())->toHaveCount(3);

    $this->travel(1)->minutes();
    $this->travel(1)->seconds();
    $notifier->notify('warning', 'Scanner unreachable', ['service' => 'scanner']);

    $texts = sentTexts();
    expect($texts)->toHaveCount(4)
        ->and($texts[0])->not->toContain('×')
        // The two duplicates held back are reported with the next one.
        ->and($texts[3])->toContain('×2');
});

test('notifier_failure_never_throws', function () {
    Log::spy();
    $notifier = telegram();

    Http::fake(['api.telegram.org/*' => fn () => throw new ConnectionException('cURL error 28 for https://api.telegram.org/bot'.FAKE_BOT_TOKEN.'/sendMessage')]);
    $notifier->notify('critical', 'Database down');

    Http::fake(['api.telegram.org/*' => Http::response(['ok' => false], 500)]);
    $notifier->notify('critical', 'Database down again');

    // Redis gone too: the alert is still attempted, and nothing is thrown either.
    config(['database.redis.default.port' => 1, 'database.redis.default.read_timeout' => 0.2, 'database.redis.default.timeout' => 0.2]);
    app('redis')->purge();
    $notifier->notify('critical', 'Everything down');

    // Logged locally below the level relayed to Telegram, and never with the token (the URL).
    Log::shouldHaveReceived('warning')->atLeast()->times(2)->withArgs(function (string $message, array $context = []) {
        expect($message.json_encode($context))->not->toContain(FAKE_BOT_TOKEN);

        return true;
    });
    Log::shouldNotHaveReceived('error');
    Log::shouldNotHaveReceived('critical');
});

test('payload_contains_no_message_body_or_email', function () {
    Http::fake(['api.telegram.org/*' => Http::response(['ok' => true])]);

    telegram()->notify('warning', 'Moderation by alice@example.com', [
        'action' => 'message.moderated_delete',
        'target_id' => 42,
        'body' => 'the secret message body',
        'email' => 'bob@example.com',
        'name' => 'Bob Personal',
        'route' => 'api/v1/admin/messages/{id} (carol@example.org)',
        'nested' => ['body' => 'nested secret'],
        'exception' => str_repeat('X', 500),
    ]);

    $text = sentTexts()[0];
    expect($text)->toContain('message.moderated_delete')
        ->toContain('target_id: 42')
        ->toContain('api/v1/admin/messages/{id}')
        ->not->toContain('secret')
        ->not->toContain('@example')
        ->not->toContain('Bob Personal')
        ->not->toContain(str_repeat('X', 200));
});

test('error_log_relayed_to_notifier', function () {
    $notifier = new RecordingNotifier;
    app()->instance(AdminNotifier::class, $notifier);

    Log::channel('telegram')->warning('not relayed');
    Log::channel('telegram')->error('Message {id} failed for dave@example.com', [
        'id' => 7,
        'exception' => new RuntimeException('SQL insert with body "the secret message body"'),
    ]);
    Log::channel('telegram')->critical('Disk full');

    expect($notifier->alerts)->toHaveCount(2);
    [$error, $critical] = $notifier->alerts;
    expect($error['level'])->toBe('error')
        ->and($error['context']['exception'])->toBe('RuntimeException')
        ->and($critical['level'])->toBe('critical')
        ->and(json_encode($notifier->alerts))->not->toContain('secret')->not->toContain('example.com');
});

test('the telegram log channel is part of the stack and never recurses', function () {
    expect(config('logging.channels.stack.channels'))->toContain('telegram');

    // A notifier that itself logs an error while notifying: relayed once, not forever.
    $notifier = new class extends RecordingNotifier
    {
        public function notify(string $level, string $title, array $context = []): void
        {
            parent::notify($level, $title, $context);
            Log::channel('telegram')->error('notifier failed');
        }
    };
    app()->instance(AdminNotifier::class, $notifier);

    Log::channel('telegram')->error('first');

    expect($notifier->alerts)->toHaveCount(1);
});

test('reported exceptions reach the notifier through the default stack', function () {
    $notifier = new RecordingNotifier;
    app()->instance(AdminNotifier::class, $notifier);
    config(['logging.default' => 'stack', 'logging.channels.stack.channels' => ['telegram', 'null']]);
    Log::forgetChannel('stack');

    report(new LogicException('boom'));

    expect($notifier->alerts)->toHaveCount(1)
        ->and($notifier->alerts[0]['context']['exception'])->toBe('LogicException');
});
