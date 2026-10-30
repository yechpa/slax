<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Sensitive actions (App\Services\AuditLogger). Instance-wide, like users: no workspace id.
     * Never a message body or an e-mail address; the target is a type and an id.
     */
    public function up(): void
    {
        Schema::create('audit_logs', function (Blueprint $table) {
            $table->id();
            // Null for anonymous events (failed sign-ins) and scheduled tasks; kept when the actor is deleted.
            $table->foreignId('actor_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('action', 64);
            $table->string('target_type', 32)->nullable();
            // No foreign key: the target may be deleted (that is often the point).
            $table->unsignedBigInteger('target_id')->nullable();
            // As the application resolves it (trusted proxies: see the deployment notes).
            $table->string('ip', 45)->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->index('created_at');
            $table->index('actor_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('audit_logs');
    }
};
