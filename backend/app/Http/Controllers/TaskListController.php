<?php

namespace App\Http\Controllers;

use App\Http\Resources\TaskListResource;
use App\Models\Task;
use App\Models\TaskList;
use App\Services\TaskService;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;

class TaskListController extends Controller
{
    public function __construct(private readonly TaskService $tasks) {}

    /** The caller's lists in order, each with the number of tasks still open for them. */
    public function index(Request $request): JsonResponse
    {
        $lists = TaskList::where('user_id', $request->user()->id)
            ->withCount(self::openCount($request))
            ->orderBy('position')->orderBy('id')
            ->get();

        return response()->json(TaskListResource::collection($lists)->resolve($request));
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate(['name' => ['required', 'string', 'max:60']]);

        $list = $this->tasks->createList($request->user(), $data['name']);
        $list->loadCount(self::openCount($request));

        return (new TaskListResource($list))->response()->setStatusCode(201);
    }

    public function update(Request $request, TaskList $taskList): TaskListResource
    {
        Gate::authorize('manage', $taskList);

        $data = $request->validate([
            'name' => ['sometimes', 'required', 'string', 'max:60'],
            'position' => ['sometimes', 'required', 'integer', 'min:0'],
        ]);

        if (isset($data['name'])) {
            $this->tasks->renameList($taskList, $data['name']);
        }
        if (isset($data['position'])) {
            $this->tasks->moveList($taskList, (int) $data['position']);
        }
        $taskList->loadCount(self::openCount($request));

        return new TaskListResource($taskList);
    }

    public function destroy(TaskList $taskList): Response
    {
        Gate::authorize('manage', $taskList);

        $this->tasks->deleteList($taskList);

        return response()->noContent();
    }

    /** @return array<string, \Closure(Builder<Task>): mixed> */
    private static function openCount(Request $request): array
    {
        return ['tasks as open_count' => fn (Builder $tasks) => $tasks
            ->where('assignee_id', $request->user()->id)->whereNull('completed_at')];
    }
}
