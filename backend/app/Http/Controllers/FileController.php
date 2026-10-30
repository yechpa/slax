<?php

namespace App\Http\Controllers;

use App\Http\Resources\FileResource;
use App\Models\Channel;
use App\Services\FileUploads;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

/** Uploads, for a channel the caller may post in. */
class FileController extends Controller
{
    public function store(Request $request, FileUploads $uploads): JsonResponse
    {
        $data = $request->validate([
            'file' => ['required', 'file'],
            'channel_id' => ['required', 'integer'],
        ]);
        $channel = Channel::findOrFail($data['channel_id']);
        Gate::authorize('view', $channel);
        Gate::authorize('post', $channel);

        $file = $uploads->store($request->user(), $channel, $request->file('file'));

        return (new FileResource($file))->response()->setStatusCode(201);
    }
}
