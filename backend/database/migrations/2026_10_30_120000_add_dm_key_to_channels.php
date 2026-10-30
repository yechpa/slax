<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * One conversation per exact set of participants: `dm_key` is the sorted
     * participant ids ("dm:12,40,77"). Rooms leave it NULL, and NULLs never
     * collide in a unique index, so a plain UNIQUE column is enough.
     */
    public function up(): void
    {
        DB::statement('ALTER TABLE channels ADD COLUMN dm_key varchar(64) NULL');
        DB::statement('ALTER TABLE channels ADD CONSTRAINT channels_dm_key_unique UNIQUE (dm_key)');
        DB::statement("ALTER TABLE channels ADD CONSTRAINT channels_dm_key_check CHECK ((kind IN ('dm', 'group_dm')) = (dm_key IS NOT NULL))");
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE channels DROP CONSTRAINT channels_dm_key_check');
        DB::statement('ALTER TABLE channels DROP CONSTRAINT channels_dm_key_unique');
        DB::statement('ALTER TABLE channels DROP COLUMN dm_key');
    }
};
