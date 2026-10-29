<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('users', function (Blueprint $table) {
            $table->id();
            // Identity is the stable Google subject; there is no password at all.
            $table->string('google_sub')->unique();
            $table->string('email');
            $table->string('name');
            $table->text('avatar_url')->nullable();
            $table->string('locale', 2)->default('en');
            $table->string('theme', 16)->default('console');
            $table->timestamp('last_seen_at')->nullable();
            $table->boolean('is_admin')->default(false);
            $table->timestamp('banned_at')->nullable();
            $table->timestamps();

            $table->index('email');
        });

        DB::statement("ALTER TABLE users ADD CONSTRAINT users_locale_check CHECK (locale IN ('en', 'he', 'fr'))");
        DB::statement("ALTER TABLE users ADD CONSTRAINT users_theme_check CHECK (theme IN ('console', 'listing'))");

        Schema::create('sessions', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->foreignId('user_id')->nullable()->index();
            $table->string('ip_address', 45)->nullable();
            $table->text('user_agent')->nullable();
            $table->longText('payload');
            $table->integer('last_activity')->index();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('users');
        Schema::dropIfExists('sessions');
    }
};
