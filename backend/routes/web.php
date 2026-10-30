<?php

use App\Http\Controllers\E2eSignInController;
use App\Http\Controllers\GoogleAuthController;
use Illuminate\Support\Facades\Route;

// The SPA is served by the frontend. Only the browser's return trip from Google lands here.
Route::get('/auth/google/callback', [GoogleAuthController::class, 'callback'])->middleware('throttle:auth-callback');

// End-to-end stack only (`make e2e`): the stand-in for Google's consent page. Never registered elsewhere.
if (app()->environment('e2e')) {
    Route::get('/auth/e2e/google', [E2eSignInController::class, 'chooser']);
    Route::get('/auth/e2e/google/approve', [E2eSignInController::class, 'approve']);
}
