<?php

namespace Tests\Support;

use RuntimeException;

/**
 * Minimal blocking WebSocket client (RFC 6455, text frames only) for the opt-in
 * end-to-end test against the dev Reverb server. Speaks just enough of the
 * Pusher protocol through send()/waitFor().
 */
final class WebSocketClient
{
    private bool $closed = false;

    /** @param resource $stream */
    private function __construct(private $stream) {}

    public static function connect(string $host, int $port, string $path): self
    {
        $stream = @stream_socket_client("tcp://{$host}:{$port}", $errno, $error, 5);
        if ($stream === false) {
            throw new RuntimeException("Cannot reach {$host}:{$port}: {$error}");
        }

        $key = base64_encode(random_bytes(16));
        fwrite($stream, "GET {$path} HTTP/1.1\r\nHost: {$host}:{$port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            ."Sec-WebSocket-Key: {$key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://localhost\r\n\r\n");

        $client = new self($stream);
        $head = '';
        while (! str_contains($head, "\r\n\r\n")) {
            $byte = $client->read(1, 5);
            if ($byte === null) {
                throw new RuntimeException('WebSocket handshake failed');
            }
            $head .= $byte;
        }
        if (! str_starts_with($head, 'HTTP/1.1 101')) {
            throw new RuntimeException('WebSocket upgrade refused: '.strtok($head, "\r\n"));
        }

        return $client;
    }

    /** @param array<string, mixed> $message */
    public function send(array $message): void
    {
        $payload = json_encode($message, JSON_THROW_ON_ERROR);
        $length = strlen($payload);
        $header = chr(0x81);
        if ($length < 126) {
            $header .= chr(0x80 | $length);
        } elseif ($length < 65536) {
            $header .= chr(0x80 | 126).pack('n', $length);
        } else {
            $header .= chr(0x80 | 127).pack('J', $length);
        }
        $mask = random_bytes(4);
        $masked = '';
        for ($i = 0; $i < $length; $i++) {
            $masked .= $payload[$i] ^ $mask[$i % 4];
        }
        fwrite($this->stream, $header.$mask.$masked);
    }

    /**
     * The next Pusher message named $event, skipping others.
     * Null when nothing came within $seconds or the server closed the connection.
     *
     * @return array<string, mixed>|null
     */
    public function waitFor(string $event, float $seconds = 5): ?array
    {
        $deadline = microtime(true) + $seconds;
        while (($left = $deadline - microtime(true)) > 0) {
            $message = $this->receive($left);
            if ($message === null) {
                return null;
            }
            if (($message['event'] ?? null) === $event) {
                return $message;
            }
        }

        return null;
    }

    public function isClosed(): bool
    {
        return $this->closed;
    }

    public function close(): void
    {
        if (! $this->closed) {
            fwrite($this->stream, chr(0x88).chr(0x80).random_bytes(4));
            fclose($this->stream);
            $this->closed = true;
        }
    }

    /** @return array<string, mixed>|null */
    private function receive(float $seconds): ?array
    {
        while (true) {
            $head = $this->read(2, $seconds);
            if ($head === null) {
                return null;
            }
            $opcode = ord($head[0]) & 0x0F;
            $length = ord($head[1]) & 0x7F;
            if ($length === 126) {
                $length = unpack('n', (string) $this->read(2, $seconds))[1];
            } elseif ($length === 127) {
                $length = unpack('J', (string) $this->read(8, $seconds))[1];
            }
            $payload = $length > 0 ? $this->read($length, $seconds) : '';
            if ($payload === null || $opcode === 0x8) {
                $this->closed = true;

                return null;
            }
            if ($opcode === 0x1) {
                return json_decode($payload, true);
            }
            // Ping, pong and anything else: ignore (Reverb also speaks Pusher-level pings).
        }
    }

    /** Exactly $bytes bytes, or null on timeout or end of stream. */
    private function read(int $bytes, float $seconds): ?string
    {
        if ($this->closed) {
            return null;
        }
        $buffer = '';
        $deadline = microtime(true) + $seconds;
        while (strlen($buffer) < $bytes) {
            $left = $deadline - microtime(true);
            if ($left <= 0) {
                return null;
            }
            $read = [$this->stream];
            $none = null;
            if (@stream_select($read, $none, $none, (int) $left, (int) (fmod($left, 1) * 1_000_000)) !== 1) {
                return null;
            }
            $chunk = fread($this->stream, $bytes - strlen($buffer));
            if ($chunk === '' || $chunk === false) {
                $this->closed = true;

                return null;
            }
            $buffer .= $chunk;
        }

        return $buffer;
    }
}
