<?php

namespace App\Http\Controllers;

use App\Http\Resources\TaskResource;
use App\Models\Task;
use App\Services\TaskService;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;

class TaskController extends Controller
{
    /** People one request may name. */
    private const MAX_ASSIGNEES = 10;

    public function __construct(private readonly TaskService $tasks) {}

    /**
     * Unfiled tasks assigned to the caller, all of them: TaskService::MAX_INBOX caps assignments only, and deleting a
     * list or giving tasks back to their author may unfile past it.
     */
    public function inbox(Request $request): JsonResponse
    {
        return $this->listTasks($request, Task::where('assignee_id', $request->user()->id)->whereNull('list_id'));
    }

    /** Tasks the caller created for somebody else. */
    public function byMe(Request $request): JsonResponse
    {
        return $this->listTasks($request, Task::where('creator_id', $request->user()->id)->where('assignee_id', '!=', $request->user()->id));
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'title' => ['required', 'string', 'max:200'],
            'visibility' => ['required', Rule::in([Task::PUBLIC, Task::PRIVATE])],
            'list_id' => ['nullable', 'integer'],
            'assignee_id' => ['nullable', 'integer'],
            'assignee_ids' => ['sometimes', 'array', 'min:1', 'max:'.self::MAX_ASSIGNEES],
            'assignee_ids.*' => ['integer'],
        ]);

        // `assignee_ids` is the list of people; `assignee_id` (one person) is still accepted.
        $ids = $data['assignee_ids'] ?? (isset($data['assignee_id']) ? [$data['assignee_id']] : []);

        $copies = $this->tasks->createTasks(
            $request->user(),
            $data['title'],
            $data['visibility'],
            isset($data['list_id']) ? (int) $data['list_id'] : null,
            array_map('intval', $ids),
        );

        return (new TaskResource($this->withPeople($copies->firstOrFail())))->response()->setStatusCode(201);
    }

    /** Gives the task to more people: one new copy each. Answers the copies created (none when everyone already had one). */
    public function assign(Request $request, Task $task): JsonResponse
    {
        Gate::authorize('edit', $task);

        $data = $request->validate([
            'assignee_ids' => ['required', 'array', 'min:1', 'max:'.self::MAX_ASSIGNEES],
            'assignee_ids.*' => ['integer'],
            'list_id' => ['nullable', 'integer'],
        ]);

        $copies = $this->tasks->assignAlso($task, array_map('intval', $data['assignee_ids']), isset($data['list_id']) ? (int) $data['list_id'] : null);
        $copies->each(fn (Task $copy) => $this->withPeople($copy));

        return response()->json(TaskResource::collection($copies)->resolve($request));
    }

    public function update(Request $request, Task $task): TaskResource
    {
        Gate::authorize('edit', $task);

        $data = $request->validate([
            'title' => ['sometimes', 'required', 'string', 'max:200'],
            'visibility' => ['sometimes', 'required', Rule::in([Task::PUBLIC, Task::PRIVATE])],
            'assignee_id' => ['sometimes', 'required', 'integer'],
        ]);

        return new TaskResource($this->withPeople($this->tasks->updateTask($task, $data)));
    }

    public function complete(Request $request, Task $task): TaskResource
    {
        Gate::authorize('complete', $task);

        $data = $request->validate(['completed' => ['required', 'boolean']]);

        return new TaskResource($this->withPeople($this->tasks->setCompleted($task, (bool) $data['completed'])));
    }

    public function move(Request $request, Task $task): TaskResource
    {
        Gate::authorize('move', $task);

        $data = $request->validate(['list_id' => ['present', 'nullable', 'integer']]);

        return new TaskResource($this->withPeople($this->tasks->moveTask($task, isset($data['list_id']) ? (int) $data['list_id'] : null)));
    }

    public function return(Task $task): TaskResource
    {
        Gate::authorize('return', $task);

        return new TaskResource($this->withPeople($this->tasks->returnToAuthor($task)));
    }

    public function destroy(Task $task): Response
    {
        Gate::authorize('delete', $task);

        $this->tasks->deleteTask($task);

        return response()->noContent();
    }

    /** @param  Builder<Task>  $query */
    private function listTasks(Request $request, Builder $query): JsonResponse
    {
        $tasks = $query->with(['creator:id,name,avatar_url', 'assignee:id,name,avatar_url'])
            ->orderBy('position')->orderBy('id')
            ->get();

        return response()->json(TaskResource::collection($tasks)->resolve($request));
    }

    /** `creator` and `assignee` as the resource shows them (a reassignment changes the latter). */
    private function withPeople(Task $task): Task
    {
        return $task->load(['creator:id,name,avatar_url', 'assignee:id,name,avatar_url']);
    }
}
