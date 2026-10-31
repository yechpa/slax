<?php

namespace App\Http\Controllers;

use App\Http\Resources\FileResource;
use App\Models\Channel;
use App\Models\File;
use App\Services\FileUploads;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Storage;

/**
 * Uploads (for a channel the caller may post in) and downloads. Files are never served
 * by the API itself: a download is a redirect to a short-lived presigned object URL.
 */
class FileController extends Controller
{
    public const DOWNLOAD_URL_TTL_SECONDS = 60;

    /** Same bucket as `s3`, at the endpoint browsers reach; only used to sign URLs. */
    public const DOWNLOAD_DISK = 's3-public';

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

    public function download(File $file): RedirectResponse
    {
        Gate::authorize('download', $file);

        $url = Storage::disk(self::DOWNLOAD_DISK)->temporaryUrl(
            $file->storage_key,
            now()->addSeconds(self::DOWNLOAD_URL_TTL_SECONDS),
            [
                'ResponseContentType' => $file->mime,
                'ResponseContentDisposition' => $file->contentDisposition(),
            ],
        );

        return redirect()->away($url)->withHeaders([
            'Cache-Control' => 'no-store, private',
            // The file's host learns nothing of the app's URLs.
            'Referrer-Policy' => 'no-referrer',
        ]);
    }
}
