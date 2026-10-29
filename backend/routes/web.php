<?php

use App\Http\Controllers\GoogleAuthController;
use Illuminate\Support\Facades\Route;

// The SPA is served by the frontend. Only the browser's return trip from Google lands here.
Route::get('/auth/google/callback', [GoogleAuthController::class, 'callback'])->middleware('throttle:auth-callback');
