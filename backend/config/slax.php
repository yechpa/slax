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

];
