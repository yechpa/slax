<?php

namespace Database\Factories;

use App\Models\Channel;
use App\Models\Workspace;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * Public channel of the default workspace (seed it first with DefaultWorkspaceSeeder).
 *
 * @extends Factory<Channel>
 */
class ChannelFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'workspace_id' => fn () => Workspace::default()->id,
            'kind' => Channel::KIND_PUBLIC,
            'name' => fake()->unique()->bothify('chan-####??'),
            'topic' => null,
        ];
    }

    public function private(): static
    {
        return $this->state(['kind' => Channel::KIND_PRIVATE]);
    }
}
