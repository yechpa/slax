<?php

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
    });
});
