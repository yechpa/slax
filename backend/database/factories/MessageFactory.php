<?php

namespace Database\Factories;

use App\Models\Message;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * Pass channel_id and user_id (and parent_id for a reply).
 *
 * @extends Factory<Message>
 */
class MessageFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'body' => fake()->sentence(),
            'client_id' => (string) Str::uuid(),
        ];
    }
}
