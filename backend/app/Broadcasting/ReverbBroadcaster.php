<?php

namespace App\Broadcasting;

use Illuminate\Broadcasting\Broadcasters\PusherBroadcaster;
use Illuminate\Http\Request;

/**
 * The stock Pusher-protocol broadcaster, plus what revocation needs.
 *
 * Reverb (1.x) does not implement `pusher:signin`, so a socket only gets a user id
 * from the `channel_data` of its subscriptions. Every private-channel authorization
 * therefore carries a signed `{"user_id": "<id>"}`: Reverb checks the signature
 * (it covers channel_data) and stores the user id on the subscription, which is what
 * its `POST /apps/{app}/users/{user}/terminate_connections` endpoint matches on.
 */
class ReverbBroadcaster extends PusherBroadcaster
{
    /**
     * @param  Request  $request
     * @param  mixed  $result
     * @return mixed
     */
    public function validAuthenticationResponse($request, $result)
    {
        $channel = (string) $request->channel_name;

        if (! str_starts_with($channel, 'private-') || str_starts_with($channel, 'private-encrypted-')) {
            return parent::validAuthenticationResponse($request, $result);
        }

        $user = $this->retrieveUser($request, $this->normalizeChannelName($channel));
        $channelData = json_encode(['user_id' => (string) $user->getAuthIdentifier()], JSON_THROW_ON_ERROR);

        return $this->decodePusherResponse(
            $request,
            $this->getPusher()->authorizeChannel($channel, $request->socket_id, $channelData),
        );
    }

    /** Closes every socket the user has open on Reverb; clients reconnect and must re-authorize each channel. */
    public function terminateUserConnections(int|string $userId): void
    {
        $this->getPusher()->terminateUserConnections((string) $userId);
    }
}
