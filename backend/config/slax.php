<?php

return [

    /*
    | Google accounts that are administrators (comma separated in ADMIN_EMAILS),
    | compared case-insensitively. Only Google-verified addresses ever sign in.
    */
    'admin_emails' => array_values(array_filter(array_map(
        fn (string $email) => strtolower(trim($email)),
        explode(',', (string) env('ADMIN_EMAILS', '')),
    ))),

    /*
    | Administrator alerts (Telegram, see config/services.php). Every message starts with
    | the environment label: "[Dev]" unless SLAX_ENV_LABEL says otherwise (production
    | sets SLAX_ENV_LABEL=Prod).
    */
    'alerts' => [
        'env_label' => env('SLAX_ENV_LABEL', 'Dev'),

        // A burst of failed sign-ins from one IP address: this many within the window
        // (fixed windows) raises one alert per window.
        'failed_sign_in_threshold' => (int) env('SLAX_FAILED_SIGN_IN_THRESHOLD', 10),
        'failed_sign_in_window_minutes' => (int) env('SLAX_FAILED_SIGN_IN_WINDOW_MINUTES', 10),
    ],

    /* Audit log entries are kept this long (audit:prune, daily). */
    'audit' => [
        'retention_days' => (int) env('SLAX_AUDIT_RETENTION_DAYS', 180),
    ],

    /*
    | The public demo: accounts signed up by visitors are kept while they are used, and
    | deleted after this many days without activity (slax:demo-reset, nightly).
    */
    'demo' => [
        // The nightly reset deletes visitors' accounts and content: off unless the environment
        // turns it on (the public showcase only; see docs/known-limitations.md).
        'reset_enabled' => filter_var(env('SLAX_DEMO_RESET_ENABLED', false), FILTER_VALIDATE_BOOL),
        'inactive_days' => 7,
        'reset_time' => '03:00',
        'reset_timezone' => 'Asia/Jerusalem',
    ],

];
