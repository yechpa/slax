<?php

namespace App\Services\Push;

enum PushOutcome
{
    /** Accepted by the push service. */
    case Delivered;

    /** 404 or 410: the browser unsubscribed or the subscription expired. Delete it. */
    case Gone;

    /** No answer, 429 or 5xx: worth another try later. */
    case Retry;

    /** Any other refusal (400, 401, 403, 413, unusable keys): another try would fail the same way. */
    case Rejected;
}
