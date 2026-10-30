<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * `dm_key` lists every participant id ("dm:12,40,77"): up to 8 ids of up to 19 digits,
     * 162 characters, more than the 64 it had (a 500 for 8 people with 7-digit ids). Text,
     * still unique.
     */
    public function up(): void
    {
        DB::statement('ALTER TABLE channels ALTER COLUMN dm_key TYPE text');
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE channels ALTER COLUMN dm_key TYPE varchar(64)');
    }
};
