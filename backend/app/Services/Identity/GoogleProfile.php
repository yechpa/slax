<?php

namespace App\Services\Identity;

final readonly class GoogleProfile
{
    public function __construct(
        public string $sub,
        public string $email,
        public bool $emailVerified,
        public string $name,
        public ?string $avatar,
    ) {}
}
