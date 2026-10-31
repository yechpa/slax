<?php

namespace App\Enums;

/**
 * What the app shows next to a person. The single place to add v2's `calling`.
 */
enum PresenceState: string
{
    case Online = 'online';
    case Away = 'away';
    case Offline = 'offline';
}
