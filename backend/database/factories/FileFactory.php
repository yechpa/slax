<?php

namespace Database\Factories;

use App\Models\File;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * A stored, unattached text file. Pass user_id and channel_id (and message_id to attach it).
 * No object is written: tests that need one put it in the faked disk themselves.
 *
 * @extends Factory<File>
 */
class FileFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'storage_key' => File::newStorageKey(),
            'display_name' => 'file.txt',
            'mime' => 'text/plain',
            'size' => 5,
            'sha256' => hash('sha256', 'hello'),
            'scan_status' => File::STATUS_CLEAN,
        ];
    }
}
