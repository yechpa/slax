<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Default Reverb Server
    |--------------------------------------------------------------------------
    |
    | This option controls the default server used by Reverb to handle
    | incoming messages as well as broadcasting message to all your
    | connected clients. At this time only "reverb" is supported.
    |
    */

    'default' => env('REVERB_SERVER', 'reverb'),

    /*
    |--------------------------------------------------------------------------
    | Reverb Servers
    |--------------------------------------------------------------------------
    |
    | Here you may define details for each of the supported Reverb servers.
    | Each server has its own configuration options that are defined in
    | the array below. You should ensure all the options are present.
    |
    */

    'servers' => [

        'reverb' => [
            'host' => env('REVERB_SERVER_HOST', '0.0.0.0'),
            'port' => env('REVERB_SERVER_PORT', 8080),
            'path' => env('REVERB_SERVER_PATH', ''),
            'hostname' => env('REVERB_HOST'),
            'options' => [
                'tls' => [],
            ],
            'max_request_size' => env('REVERB_MAX_REQUEST_SIZE', 131_072),
            'scaling' => [
                'enabled' => env('REVERB_SCALING_ENABLED', false),
                'channel' => env('REVERB_SCALING_CHANNEL', 'reverb'),
                'server' => [
                    'url' => env('REDIS_URL'),
                    'host' => env('REDIS_HOST', '127.0.0.1'),
                    'port' => env('REDIS_PORT', '6379'),
                    'username' => env('REDIS_USERNAME'),
                    'password' => env('REDIS_PASSWORD'),
                    'database' => env('REDIS_DB', '0'),
                    'timeout' => env('REDIS_TIMEOUT', 60),
                ],
            ],
            'pulse_ingest_interval' => env('REVERB_PULSE_INGEST_INTERVAL', 15),
            'telescope_ingest_interval' => env('REVERB_TELESCOPE_INGEST_INTERVAL', 15),
        ],

    ],

    /*
    |--------------------------------------------------------------------------
    | Reverb Applications
    |--------------------------------------------------------------------------
    |
    | Here you may define how Reverb applications are managed. If you choose
    | to use the "config" provider, you may define an array of apps which
    | your server will support, including their connection credentials.
    |
    */

    'apps' => [

        'provider' => 'config',

        'apps' => [
            [
                'key' => env('REVERB_APP_KEY'),
                'secret' => env('REVERB_APP_SECRET'),
                'app_id' => env('REVERB_APP_ID'),
                'options' => [
                    'host' => env('REVERB_HOST'),
                    'port' => env('REVERB_PORT', 443),
                    'scheme' => env('REVERB_SCHEME', 'https'),
                    'useTLS' => env('REVERB_SCHEME', 'https') === 'https',
                ],
                // Hosts whose pages may open a WebSocket (the browser's Origin header), comma
                // separated: the deployment's own host (Helm chart); anything locally.
                'allowed_origins' => array_values(array_filter(array_map('trim', explode(',', (string) env('REVERB_ALLOWED_ORIGINS', '*'))))),
                'ping_interval' => env('REVERB_APP_PING_INTERVAL', 60),
                'activity_timeout' => env('REVERB_APP_ACTIVITY_TIMEOUT', 30),
                // No cap by default, deliberately: Reverb counts a socket once it subscribed to any
                // channel, public names need no authorization, and pusher-js never retries a refused
                // (4004) socket, so anyone could fill a cap and lock everybody out until reload. The pod's
                // memory limit is the bound (see docs/known-limitations.md).
                'max_connections' => env('REVERB_APP_MAX_CONNECTIONS') === null ? null : (int) env('REVERB_APP_MAX_CONNECTIONS'),
                'max_message_size' => env('REVERB_APP_MAX_MESSAGE_SIZE', 10_000),
                // Typing "whispers" (client-typing on private channels): only from sockets subscribed
                // to the channel, relayed to the others and tagged with the sender's signed user id.
                // The strictest setting that allows client events; deliberately not an env variable.
                'accept_client_events_from' => 'members',
                // Per socket: every frame it sends counts (subscriptions, pings, whispers), at most
                // max_attempts per decay_seconds; beyond, each frame is refused (pusher error 4301)
                // and dropped, the socket stays. On by default, everywhere: a modified client cannot
                // make Reverb relay whispers without limit. 300 a minute leaves a reconnection that
                // re-subscribes 30 channels and the presence channel far inside it (reverb-e2e tests).
                'rate_limiting' => [
                    'enabled' => (bool) env('REVERB_APP_RATE_LIMITING_ENABLED', true),
                    'max_attempts' => (int) env('REVERB_APP_RATE_LIMIT_MAX_ATTEMPTS', 300),
                    'decay_seconds' => (int) env('REVERB_APP_RATE_LIMIT_DECAY_SECONDS', 60),
                    'terminate_on_limit' => (bool) env('REVERB_APP_RATE_LIMIT_TERMINATE', false),
                ],
            ],
        ],

    ],

];
