<?php

use App\Http\Controllers\AdminController;
use App\Http\Controllers\ChannelController;
use App\Http\Controllers\DirectChannelController;
use App\Http\Controllers\FileController;
use App\Http\Controllers\GoogleAuthController;
use App\Http\Controllers\MeController;
use App\Http\Controllers\MessageController;
use App\Http\Controllers\PresenceController;
use App\Http\Controllers\PushSubscriptionController;
use App\Http\Controllers\ReactionController;
use App\Http\Controllers\UserController;
use Illuminate\Support\Facades\Route;

Route::prefix('v1')->group(function () {
    Route::get('/health', fn () => response()->json(['status' => 'ok']));

    Route::post('/auth/google/start', [GoogleAuthController::class, 'start'])->middleware('throttle:auth-start');

    Route::middleware(['auth:sanctum', 'not-banned'])->group(function () {
        Route::post('/auth/logout', [GoogleAuthController::class, 'logout']);
        Route::get('/me', [MeController::class, 'show']);
        Route::patch('/me', [MeController::class, 'update']);

        Route::post('/presence/heartbeat', [PresenceController::class, 'heartbeat'])->middleware('throttle:presence-heartbeat');
        Route::get('/presence', [PresenceController::class, 'index']);

        // Web Push for this device (404 push_disabled without VAPID keys, except DELETE).
        Route::get('/push/public-key', [PushSubscriptionController::class, 'publicKey']);
        Route::post('/push/subscriptions', [PushSubscriptionController::class, 'store'])->middleware('throttle:push-subscriptions');
        Route::delete('/push/subscriptions', [PushSubscriptionController::class, 'destroy'])->middleware('throttle:push-subscriptions');
        Route::post('/push/test', [PushSubscriptionController::class, 'test'])->middleware('throttle:push-test');

        Route::get('/users', [UserController::class, 'index'])->middleware('throttle:user-search');

        Route::get('/channels', [ChannelController::class, 'index']);
        Route::post('/channels', [ChannelController::class, 'store']);
        Route::get('/channels/{channel}', [ChannelController::class, 'show']);
        Route::post('/channels/{channel}/join', [ChannelController::class, 'join']);
        Route::post('/channels/{channel}/leave', [ChannelController::class, 'leave']);
        Route::post('/channels/{channel}/read', [ChannelController::class, 'read'])->middleware('throttle:reads');
        Route::get('/channels/{channel}/members', [ChannelController::class, 'members']);
        Route::post('/channels/{channel}/members', [ChannelController::class, 'addMember']);
        Route::delete('/channels/{channel}/members/{user}', [ChannelController::class, 'removeMemberRoute']);

        Route::post('/dms', [DirectChannelController::class, 'store'])->middleware('throttle:dms');

        Route::get('/channels/{channel}/messages', [MessageController::class, 'index']);
        Route::post('/channels/{channel}/messages', [MessageController::class, 'store'])->middleware('throttle:messages');
        Route::get('/messages/{message}/replies', [MessageController::class, 'replies']);
        Route::patch('/messages/{message}', [MessageController::class, 'update']);
        Route::delete('/messages/{message}', [MessageController::class, 'destroy']);
        Route::put('/messages/{message}/reactions/{emoji}', [ReactionController::class, 'store']);
        Route::delete('/messages/{message}/reactions/{emoji}', [ReactionController::class, 'destroy']);

        Route::post('/files', [FileController::class, 'store'])->middleware('throttle:uploads');
        Route::get('/files/{file}/download', [FileController::class, 'download']);

        // Administrators only: the `admin` gate runs before anything is looked up
        // (AdminTest checks every route registered here). Writes are rate limited.
        Route::prefix('admin')->middleware('can:admin')->group(function () {
            Route::get('/status', [AdminController::class, 'status']);
            Route::get('/audit', [AdminController::class, 'audit']);
            Route::get('/users', [AdminController::class, 'users']);
            Route::get('/users/banned', [AdminController::class, 'bannedUsers']);
            Route::get('/channels', [AdminController::class, 'channels']);

            Route::middleware('throttle:admin-writes')->group(function () {
                Route::post('/users/{id}/ban', [AdminController::class, 'ban'])->whereNumber('id');
                Route::post('/users/{id}/account-type', [AdminController::class, 'accountType'])->whereNumber('id');
                Route::delete('/messages/{id}', [AdminController::class, 'destroyMessage'])->whereNumber('id');
                Route::delete('/files/{id}', [AdminController::class, 'destroyFile'])->whereNumber('id');
                Route::post('/channels/{id}/lock', [AdminController::class, 'lock'])->whereNumber('id');
            });
        });
    });
});
