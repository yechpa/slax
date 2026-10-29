<?php

namespace Database\Factories;

use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<User>
 */
class UserFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'google_sub' => (string) fake()->unique()->numerify('####################'),
            'name' => fake()->name(),
            'email' => Str::lower(fake()->unique()->safeEmail()),
            'avatar_url' => null,
            'locale' => 'en',
            'theme' => 'console',
            'is_admin' => false,
            'banned_at' => null,
        ];
    }

    public function admin(): static
    {
        return $this->state(['is_admin' => true]);
    }

    public function banned(): static
    {
        return $this->state(['banned_at' => now()]);
    }
}
