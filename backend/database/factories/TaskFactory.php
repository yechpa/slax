<?php

namespace Database\Factories;

use App\Models\Task;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * A private, unfiled task of the default workspace (seed it first with DefaultWorkspaceSeeder),
 * held by its creator unless the test says otherwise. Pass creator_id, assignee_id, list_id to choose.
 *
 * @extends Factory<Task>
 */
class TaskFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'workspace_id' => fn () => Workspace::default()->id,
            'creator_id' => User::factory(),
            'assignee_id' => fn (array $attributes) => $attributes['creator_id'],
            'list_id' => null,
            'title' => fake()->sentence(3),
            'visibility' => Task::PRIVATE,
            'completed_at' => null,
            'position' => 0,
        ];
    }

    public function public(): static
    {
        return $this->state(['visibility' => Task::PUBLIC]);
    }

    public function private(): static
    {
        return $this->state(['visibility' => Task::PRIVATE]);
    }

    public function completed(): static
    {
        return $this->state(fn () => ['completed_at' => now()]);
    }

    public function unfiled(): static
    {
        return $this->state(['list_id' => null]);
    }

    public function assignedTo(User $user): static
    {
        return $this->state(['assignee_id' => $user->id]);
    }
}
