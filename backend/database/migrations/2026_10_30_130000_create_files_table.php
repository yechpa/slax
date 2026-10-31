<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('files', function (Blueprint $table) {
            $table->id();
            // Restricted: whatever deletes a user or a channel must delete the stored objects first.
            $table->foreignId('user_id')->constrained()->restrictOnDelete();
            $table->foreignId('channel_id')->constrained()->restrictOnDelete();
            // Null until a message carries the file; files:prune-orphans removes those left unattached.
            $table->foreignId('message_id')->nullable()->constrained()->nullOnDelete();
            // files/{Y}/{m}/{uuid}: never derived from the client's file name.
            $table->string('storage_key', 64)->unique();
            $table->string('display_name', 255);
            // The type the scanner detected, never the one the client declared.
            $table->string('mime', 100);
            $table->unsignedBigInteger('size');
            $table->char('sha256', 64);
            // pending: approved by the scanner, quota reserved, object being written. clean: stored and usable.
            $table->string('scan_status', 16)->default('pending');
            $table->timestamp('created_at')->useCurrent();

            $table->index('user_id');
            $table->index('message_id');
        });

        DB::statement('ALTER TABLE files ADD CONSTRAINT files_size_check CHECK (size BETWEEN 1 AND 10485760)');
        DB::statement("ALTER TABLE files ADD CONSTRAINT files_scan_status_check CHECK (scan_status IN ('pending', 'clean'))");
        // Orphan pruning walks unattached files by age.
        DB::statement('CREATE INDEX files_unattached_created_at_index ON files (created_at) WHERE message_id IS NULL');
    }

    public function down(): void
    {
        Schema::dropIfExists('files');
    }
};
