<?php

namespace Database\Seeders;

use App\Models\Channel;
use App\Models\Workspace;
use Illuminate\Database\Seeder;

/** Creates the single v1 workspace and its starter public channels. Safe to run repeatedly. */
class DefaultWorkspaceSeeder extends Seeder
{
    public const CHANNELS = [
        'general' => 'Announcements and everything that fits nowhere else',
        'random' => 'Off-topic chatter',
        'ingenierie' => 'Engineering',
        'securite' => 'Security',
    ];

    public function run(): void
    {
        $workspace = Workspace::firstOrCreate(
            ['slug' => Workspace::DEFAULT_SLUG],
            ['name' => 'Slax'],
        );

        foreach (self::CHANNELS as $name => $topic) {
            Channel::firstOrCreate(
                ['workspace_id' => $workspace->id, 'name' => $name],
                ['kind' => Channel::KIND_PUBLIC, 'topic' => $topic],
            );
        }
    }
}
