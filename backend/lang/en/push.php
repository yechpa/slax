<?php

// Web Push notifications (App\Services\Push\PushPayload). Never the message's text.
return [
    'title_room' => ':sender in #:channel',
    'title_direct' => ':sender (direct message)',
    // A sender whose name is an e-mail address (never shown in a notification).
    'someone' => 'Someone',
    'body_dm' => 'New message',
    'body_mention' => 'You were mentioned',
    'body_reply' => 'New reply',
    'test_title' => 'Slax',
    'test_body' => 'Notifications work on this device.',
];
