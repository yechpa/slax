<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // One row per browser (device) that turned notifications on: the Web Push subscription.
        Schema::create('push_subscriptions', function (Blueprint $table) {
            $table->id();
            // A deleted account (the demo reset included) takes its devices with it.
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            // The push service's URL for this browser: unique, a device belongs to one account.
            $table->text('endpoint')->unique();
            // The browser's keys (base64url) the payload is encrypted for.
            $table->string('p256dh', 128);
            $table->string('auth', 64);
            // The language notifications are written in (the app's language when it subscribed).
            $table->string('locale', 8);
            // Which VAPID public key it was made with (Push::keyId): after a key rotation the push
            // services refuse the old subscriptions, which are then deleted instead of retried.
            $table->char('key_id', 16);
            $table->timestamp('created_at')->useCurrent();
            $table->timestamp('last_used_at')->nullable();

            $table->index('user_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('push_subscriptions');
    }
};
