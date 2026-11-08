<?php

namespace Database\Factories;

use App\Models\TaskList;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * A list of the default workspace (seed it first with DefaultWorkspaceSeeder). Pass user_id to pick the owner.
 *
 * @extends Factory<TaskList>
 */
class TaskListFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'workspace_id' => fn () => Workspace::default()->id,
            'user_id' => User::factory(),
            'name' => fake()->unique()->bothify('list-####??'),
            'position' => 0,
        ];
    }
}
