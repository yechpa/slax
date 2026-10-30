<?php

use App\Http\Controllers\ChannelController;
use App\Http\Controllers\DirectChannelController;
use App\Http\Controllers\FileController;
use App\Http\Controllers\GoogleAuthController;
use App\Http\Controllers\MeController;
use App\Http\Controllers\MessageController;
use App\Http\Controllers\PresenceController;
use App\Http\Controllers\ReactionController;
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

        Route::get('/channels', [ChannelController::class, 'index']);
        Route::post('/channels', [ChannelController::class, 'store']);
        Route::get('/channels/{channel}', [ChannelController::class, 'show']);
        Route::post('/channels/{channel}/join', [ChannelController::class, 'join']);
        Route::post('/channels/{channel}/leave', [ChannelController::class, 'leave']);
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
    });
});
