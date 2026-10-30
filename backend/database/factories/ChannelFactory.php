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

    /** A conversation: anonymous, with a unique member-set key (members are attached by the test). */
    public function dm(string $kind = Channel::KIND_DM): static
    {
        return $this->state(fn () => ['kind' => $kind, 'name' => null, 'dm_key' => 'dm:'.fake()->unique()->numerify('########')]);
    }

    public function private(): static
    {
        return $this->state(['kind' => Channel::KIND_PRIVATE]);
    }
}
