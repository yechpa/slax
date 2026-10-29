<?php

namespace App\Broadcasting;

use Illuminate\Broadcasting\Broadcasters\PusherBroadcaster;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\RequestException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Pusher\Pusher;

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

    /**
     * Closes every socket the user has open on Reverb; clients reconnect and must re-authorize
     * each channel. A signed call to the Pusher HTTP API like the SDK's terminateUserConnections(),
     * but with its own (short) timeouts: it runs inside user requests.
     *
     * @throws RequestException|ConnectionException when Reverb refused or could not be reached
     */
    public function terminateUserConnections(int|string $userId, int $timeoutSeconds = 2): void
    {
        $settings = $this->getPusher()->getSettings();
        $path = "{$settings['base_path']}/users/{$userId}/terminate_connections";
        $body = '{}';
        $query = Pusher::build_auth_query_params(
            $settings['auth_key'], $settings['secret'], 'POST', $path, ['body_md5' => md5($body)],
        );

        Http::connectTimeout($timeoutSeconds)
            ->timeout($timeoutSeconds)
            ->withBody($body, 'application/json')
            ->post("{$settings['scheme']}://{$settings['host']}:{$settings['port']}{$settings['path']}{$path}?".http_build_query($query))
            ->throw();
    }
}
