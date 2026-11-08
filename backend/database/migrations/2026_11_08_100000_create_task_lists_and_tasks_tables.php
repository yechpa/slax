<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // A person's own lists: only the owner ever sees them.
        Schema::create('task_lists', function (Blueprint $table) {
            $table->id();
            $table->foreignId('workspace_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('name', 60);
            $table->unsignedInteger('position')->default(0);
            $table->timestamps();

            $table->index(['user_id', 'position']);
        });

        Schema::create('tasks', function (Blueprint $table) {
            $table->id();
            $table->foreignId('workspace_id')->constrained()->cascadeOnDelete();
            $table->foreignId('creator_id')->constrained('users')->cascadeOnDelete();
            $table->foreignId('assignee_id')->constrained('users')->cascadeOnDelete();
            // A list of the assignee; null = unfiled (the assignee's inbox). A deleted list unfiles its tasks.
            $table->foreignId('list_id')->nullable()->constrained('task_lists')->nullOnDelete();
            $table->string('title', 200);
            // 'public' | 'private'
            $table->string('visibility', 8)->default('private');
            $table->timestamp('completed_at')->nullable();
            $table->unsignedInteger('position')->default(0);
            $table->timestamps();

            $table->index(['assignee_id', 'list_id']);
            $table->index('creator_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('tasks');
        Schema::dropIfExists('task_lists');
    }
};
