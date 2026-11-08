<?php

namespace App\Http\Controllers;

use App\Http\Resources\TaskResource;
use App\Models\Task;
use App\Models\TaskList;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * A colleague's task page: what they hold that the caller may see (public tasks, plus the private ones the
 * caller created for them). A list with no such task is left out, its name with it. Banned accounts answer 404,
 * like in the people directory.
 */
class UserTaskController extends Controller
{
    public function show(Request $request, User $user): JsonResponse
    {
        abort_if($user->banned_at !== null, 404);

        $tasks = Task::query()
            ->where('assignee_id', $user->id)
            ->visibleTo($request->user())
            ->with(['creator:id,name,avatar_url', 'assignee:id,name,avatar_url'])
            ->orderBy('position')->orderBy('id')
            ->get();

        $lists = TaskList::query()
            ->whereIn('id', $tasks->pluck('list_id')->filter()->unique())
            ->orderBy('position')->orderBy('id')
            ->get(['id', 'name']);

        $byList = $tasks->groupBy('list_id');
        $resolve = fn ($group) => TaskResource::collection($group ?? collect())->resolve($request);

        return response()->json([
            'user' => ['id' => $user->id, 'name' => $user->name, 'avatar_url' => $user->avatar_url],
            'lists' => $lists->map(fn (TaskList $list) => [
                'id' => $list->id,
                'name' => $list->name,
                'tasks' => $resolve($byList->get($list->id)),
            ])->values()->all(),
            'unfiled' => $resolve($byList->get('')),
        ]);
    }
}
