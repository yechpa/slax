<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\PresenceService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/** The client side of presence; the contract is described on PresenceService. */
class PresenceController extends Controller
{
    public const MAX_IDS = 200;

    public function __construct(private readonly PresenceService $presence) {}

    public function heartbeat(Request $request): Response
    {
        $request->validate(['active' => ['required', 'boolean']]);

        $this->presence->heartbeat($request->user()->id, $request->boolean('active'));
        // Activity, as far as the demo's account expiry is concerned (one write per 15 minutes).
        $request->user()->touchLastSeen();

        return response()->noContent();
    }

    /** `{"<id>": "online|away|offline"}` for the existing users among `user_ids`; unknown ids are left out. */
    public function index(Request $request): JsonResponse
    {
        $data = $request->validate([
            'user_ids' => ['required', 'array', 'max:'.self::MAX_IDS],
            'user_ids.*' => ['integer', 'min:1'],
        ]);

        $known = User::whereIn('id', $data['user_ids'])->pluck('id')->all();

        // An object even when empty.
        return response()->json((object) $this->presence->statesOf($known));
    }
}
