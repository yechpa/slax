<?php

namespace App\Http\Controllers;

use App\Http\Resources\TaskResource;
use App\Models\Task;
use App\Services\TaskService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;

class TaskController extends Controller
{
    public function __construct(private readonly TaskService $tasks) {}

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'title' => ['required', 'string', 'max:200'],
            'visibility' => ['required', Rule::in([Task::PUBLIC, Task::PRIVATE])],
            'list_id' => ['nullable', 'integer'],
            'assignee_id' => ['nullable', 'integer'],
        ]);

        $task = $this->tasks->createTask(
            $request->user(),
            $data['title'],
            $data['visibility'],
            isset($data['list_id']) ? (int) $data['list_id'] : null,
            isset($data['assignee_id']) ? (int) $data['assignee_id'] : null,
        );

        return (new TaskResource($this->withPeople($task)))->response()->setStatusCode(201);
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

    public function destroy(Task $task): Response
    {
        Gate::authorize('delete', $task);

        $this->tasks->deleteTask($task);

        return response()->noContent();
    }

    /** `creator` and `assignee` as the resource shows them (a reassignment changes the latter). */
    private function withPeople(Task $task): Task
    {
        return $task->load(['creator:id,name,avatar_url', 'assignee:id,name,avatar_url']);
    }
}
