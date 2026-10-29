<?php

use App\Http\Controllers\ChannelController;
use App\Http\Controllers\GoogleAuthController;
use App\Http\Controllers\MeController;
use Illuminate\Support\Facades\Route;

Route::prefix('v1')->group(function () {
    Route::get('/health', fn () => response()->json(['status' => 'ok']));

    Route::post('/auth/google/start', [GoogleAuthController::class, 'start'])->middleware('throttle:auth-start');

    Route::middleware(['auth:sanctum', 'not-banned'])->group(function () {
        Route::post('/auth/logout', [GoogleAuthController::class, 'logout']);
        Route::get('/me', [MeController::class, 'show']);
        Route::patch('/me', [MeController::class, 'update']);

        Route::get('/channels', [ChannelController::class, 'index']);
        Route::post('/channels', [ChannelController::class, 'store']);
        Route::get('/channels/{channel}', [ChannelController::class, 'show']);
        Route::post('/channels/{channel}/join', [ChannelController::class, 'join']);
        Route::post('/channels/{channel}/leave', [ChannelController::class, 'leave']);
        Route::post('/channels/{channel}/members', [ChannelController::class, 'addMember']);
        Route::delete('/channels/{channel}/members/{user}', [ChannelController::class, 'removeMemberRoute']);
    });
});
