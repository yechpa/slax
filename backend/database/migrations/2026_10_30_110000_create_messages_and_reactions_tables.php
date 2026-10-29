<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('messages', function (Blueprint $table) {
            $table->id();
            $table->foreignId('channel_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            // Threads are one level deep: a reply's parent is a top-level message of the same channel (enforced by the API).
            $table->foreignId('parent_id')->nullable()->constrained('messages')->cascadeOnDelete();
            $table->text('body');
            // Idempotency key chosen by the sending client.
            $table->uuid('client_id');
            $table->timestamp('edited_at')->nullable();
            // Soft delete: the row stays (threads keep their root), the API renders a tombstone.
            $table->timestamp('deleted_at')->nullable();
            $table->timestamps();

            $table->unique(['user_id', 'client_id']);
            // Channel timeline (top-level messages by id) and thread listings.
            $table->index(['channel_id', 'parent_id', 'id']);
            $table->index(['parent_id', 'id']);
        });

        // Characters, not bytes (Hebrew letters are two bytes, most emoji four).
        DB::statement('ALTER TABLE messages ADD CONSTRAINT messages_body_length_check CHECK (char_length(body) BETWEEN 1 AND 4000)');

        Schema::create('reactions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('message_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('emoji', 16);
            $table->timestamp('created_at')->useCurrent();

            $table->unique(['message_id', 'user_id', 'emoji']);
        });

        DB::statement('ALTER TABLE reactions ADD CONSTRAINT reactions_emoji_length_check CHECK (octet_length(emoji) BETWEEN 1 AND 16)');
    }

    public function down(): void
    {
        Schema::dropIfExists('reactions');
        Schema::dropIfExists('messages');
    }
};
