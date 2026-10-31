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

    /** A visitor's account on the public demo, last seen $daysAgo days ago. */
    public function demo(int $daysAgo = 0): static
    {
        return $this->state(fn () => [
            'account_type' => User::ACCOUNT_DEMO,
            'last_seen_at' => now()->subDays($daysAgo),
            'created_at' => now()->subDays($daysAgo + 1),
        ]);
    }

    public function banned(): static
    {
        return $this->state(['banned_at' => now()]);
    }
}
