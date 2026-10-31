<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * users.account_type: `member` (administrators, and accounts that predate this column),
     * `demo` (signed up by a visitor of the public demo: deleted after 7 days without
     * activity) or `seed` (the demo's fictional people, never signing in).
     * channels.locked_at: set by an administrator; members still read, nobody else posts.
     */
    public function up(): void
    {
        DB::statement("ALTER TABLE users ADD COLUMN account_type varchar(8) NOT NULL DEFAULT 'member'");
        DB::statement("ALTER TABLE users ADD CONSTRAINT users_account_type_check CHECK (account_type IN ('member', 'demo', 'seed'))");
        DB::statement('CREATE INDEX users_account_type_last_seen_at_index ON users (account_type, last_seen_at)');

        DB::statement('ALTER TABLE channels ADD COLUMN locked_at timestamp(0) without time zone NULL');
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE channels DROP COLUMN locked_at');
        DB::statement('DROP INDEX users_account_type_last_seen_at_index');
        DB::statement('ALTER TABLE users DROP CONSTRAINT users_account_type_check');
        DB::statement('ALTER TABLE users DROP COLUMN account_type');
    }
};
