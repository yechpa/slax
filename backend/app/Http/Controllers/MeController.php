<?php

namespace App\Http\Controllers;

use App\Http\Resources\UserResource;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class MeController extends Controller
{
    public function show(Request $request): UserResource
    {
        return new UserResource($request->user());
    }

    public function update(Request $request): UserResource
    {
        $data = $request->validate([
            'locale' => ['sometimes', 'string', Rule::in(User::LOCALES)],
            'theme' => ['sometimes', 'string', Rule::in(User::THEMES)],
        ]);

        $request->user()->update($data);

        return new UserResource($request->user());
    }
}
