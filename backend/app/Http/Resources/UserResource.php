<?php

namespace App\Http\Resources;

use App\Models\User;
use App\Models\Workspace;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin User */
class UserResource extends JsonResource
{
    public static $wrap = null;

    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'email' => $this->email,
            'avatar_url' => $this->avatar_url,
            'locale' => $this->locale,
            'theme' => $this->theme,
            'is_admin' => $this->is_admin,
            // Slax v1 has one workspace; the client needs its id for the presence channel.
            'workspace_id' => Workspace::where('slug', Workspace::DEFAULT_SLUG)->value('id'),
        ];
    }
}
