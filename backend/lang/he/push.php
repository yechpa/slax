<?php

// Web Push notifications (App\Services\Push\PushPayload). Never the message's text.
// Names are isolated (U+2068 FIRST STRONG ISOLATE … U+2069 POP DIRECTIONAL ISOLATE): a Latin
// name or "#channel" keeps its own direction inside the Hebrew sentence.
return [
    'title_room' => "\u{2068}:sender\u{2069} בערוץ \u{2068}#:channel\u{2069}",
    'title_direct' => "\u{2068}:sender\u{2069} (הודעה ישירה)",
    // A sender whose name is an e-mail address (never shown in a notification).
    'someone' => 'מישהו',
    'body_dm' => 'הודעה חדשה',
    'body_mention' => 'הוזכרת בהודעה',
    'body_reply' => 'תגובה חדשה',
    'test_title' => 'Slax',
    'test_body' => 'ההתראות פועלות במכשיר הזה.',
];
