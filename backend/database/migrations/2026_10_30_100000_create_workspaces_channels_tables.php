<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('workspaces', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('slug')->unique();
            $table->timestamps();
        });

        Schema::create('channels', function (Blueprint $table) {
            $table->id();
            $table->foreignId('workspace_id')->constrained()->cascadeOnDelete();
            $table->string('kind', 16);
            // Only public and private channels have a name and a topic; DMs are anonymous.
            $table->string('name', 40)->nullable();
            $table->string('topic', 250)->nullable();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });

        DB::statement("ALTER TABLE channels ADD CONSTRAINT channels_kind_check CHECK (kind IN ('public', 'private', 'dm', 'group_dm'))");
        DB::statement("ALTER TABLE channels ADD CONSTRAINT channels_name_check CHECK ((kind IN ('public', 'private')) = (name IS NOT NULL))");
        // One namespace for public and private names inside a workspace.
        DB::statement("CREATE UNIQUE INDEX channels_workspace_id_name_unique ON channels (workspace_id, name) WHERE kind IN ('public', 'private')");

        Schema::create('channel_members', function (Blueprint $table) {
            $table->foreignId('channel_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('role', 16)->default('member');
            // Points at messages.id once that table exists (no FK on purpose).
            $table->unsignedBigInteger('last_read_message_id')->nullable();
            $table->timestamps();

            $table->primary(['channel_id', 'user_id']);
            $table->index('user_id');
        });

        DB::statement("ALTER TABLE channel_members ADD CONSTRAINT channel_members_role_check CHECK (role IN ('member', 'owner'))");
    }

    public function down(): void
    {
        Schema::dropIfExists('channel_members');
        Schema::dropIfExists('channels');
        Schema::dropIfExists('workspaces');
    }
};
