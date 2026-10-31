<?php

namespace App\Http\Resources;

use App\Models\File;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * Same for every viewer (it goes into broadcasts). `mime` is the detected type;
 * `download_url` goes through the access check, then redirects to the object.
 *
 * @mixin File
 */
class FileResource extends JsonResource
{
    /**
     * @return array{id: int, name: string, mime: string, size: int, kind: string, download_url: string}
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->display_name,
            'mime' => $this->mime,
            'size' => $this->size,
            'kind' => $this->kind(),
            'download_url' => "/api/v1/files/{$this->id}/download",
        ];
    }
}
