<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/** A message may now have an empty body when it carries files (enforced by the API). */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE messages DROP CONSTRAINT messages_body_length_check');
        DB::statement('ALTER TABLE messages ADD CONSTRAINT messages_body_length_check CHECK (char_length(body) <= 4000)');
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE messages DROP CONSTRAINT messages_body_length_check');
        DB::statement('ALTER TABLE messages ADD CONSTRAINT messages_body_length_check CHECK (char_length(body) BETWEEN 1 AND 4000)');
    }
};
