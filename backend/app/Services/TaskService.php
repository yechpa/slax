<?php

namespace App\Services;

use App\Exceptions\TaskRefused;
use App\Models\Task;
use App\Models\TaskList;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;

/** The rules for task lists and tasks. Controllers validate and authorize; this decides. */
class TaskService
{
    public const MAX_LISTS = 50;

    public const MAX_TASKS_PER_LIST = 500;

    public const MAX_INBOX = 200;

    public function createList(User $owner, string $name): TaskList
    {
        return DB::transaction(function () use ($owner, $name) {
            $this->lockOwner($owner);

            $lists = TaskList::where('user_id', $owner->id);
            if ((clone $lists)->count() >= self::MAX_LISTS) {
                throw new TaskRefused('task_list_limit');
            }
            $last = (clone $lists)->max('position');

            $list = new TaskList([
                'workspace_id' => Workspace::default()->id,
                'name' => $name,
                'position' => $last === null ? 0 : $last + 1,
            ]);
            $list->user_id = $owner->id;
            $list->save();

            return $list;
        });
    }

    public function renameList(TaskList $list, string $name): TaskList
    {
        $list->update(['name' => $name]);

        return $list;
    }

    /** Puts the list at `$position` among its owner's lists (clamped to the ends) and renumbers them 0, 1, 2... */
    public function moveList(TaskList $list, int $position): void
    {
        DB::transaction(function () use ($list, $position) {
            $this->lockOwner($list->owner);

            $others = TaskList::where('user_id', $list->user_id)->whereKeyNot($list->id)
                ->orderBy('position')->orderBy('id')->pluck('id');
            $ordered = $others->splice(0, max(0, min($position, $others->count())))
                ->push($list->id)->concat($others)->values();

            foreach ($ordered as $index => $id) {
                TaskList::whereKey($id)->where('position', '!=', $index)->update(['position' => $index]);
            }
            $list->position = $ordered->search($list->id);
            $list->syncOriginalAttribute('position');
        });
    }

    /** The owner's own tasks in the list go with it; the ones others gave them go back to their inbox. */
    public function deleteList(TaskList $list): void
    {
        DB::transaction(function () use ($list) {
            Task::where('list_id', $list->id)->where('creator_id', $list->user_id)->delete();
            Task::where('list_id', $list->id)->update(['list_id' => null]);
            $list->delete();
        });
    }

    /** The owner's first list, created (named in their language) if they have none yet. */
    public function ensureDefaultList(User $owner): TaskList
    {
        return DB::transaction(function () use ($owner) {
            $this->lockOwner($owner);

            return TaskList::where('user_id', $owner->id)->orderBy('position')->orderBy('id')->first()
                ?? $this->createList($owner, __('tasks.default_list', [], $owner->locale));
        });
    }

    /**
     * Creates a task. For yourself it goes into the given list of yours (the first one, created if need be,
     * when none is given); for a colleague it goes to their inbox, whatever `$listId` says.
     */
    public function createTask(User $by, string $title, string $visibility, ?int $listId, ?int $assigneeId): Task
    {
        $assignee = $assigneeId === null ? $by : $this->assignableUser($assigneeId);

        return DB::transaction(function () use ($by, $assignee, $title, $visibility, $listId) {
            $this->lockOwner($assignee);

            if ($assignee->is($by)) {
                $list = $listId === null
                    ? $this->ensureDefaultList($by)
                    : TaskList::where('user_id', $by->id)->find($listId) ?? throw new TaskRefused('invalid_list');
                if ($this->placeQuery($assignee, $list->id)->count() >= self::MAX_TASKS_PER_LIST) {
                    throw new TaskRefused('task_limit');
                }
                $destination = $list->id;
            } else {
                $this->ensureInboxRoom($assignee);
                $destination = null;
            }

            $task = new Task([
                'workspace_id' => Workspace::default()->id,
                'title' => trim($title),
                'visibility' => $visibility,
                'position' => $this->nextPosition($assignee, $destination),
            ]);
            $task->creator_id = $by->id;
            $task->assignee_id = $assignee->id;
            $task->list_id = $destination;
            $task->save();

            return $task;
        });
    }

    /**
     * Applies `title`, `visibility` and/or `assignee_id`. A new assignee gets the task in their inbox (no list,
     * last place) and `$task->previousAssigneeId` holds the former one; it stays null when the assignee did not change.
     *
     * @param  array{title?: string, visibility?: string, assignee_id?: int|null}  $changes
     */
    public function updateTask(Task $task, array $changes): Task
    {
        $task->previousAssigneeId = null;
        $newAssigneeId = isset($changes['assignee_id']) ? (int) $changes['assignee_id'] : null;
        $reassigned = $newAssigneeId !== null && $newAssigneeId !== $task->assignee_id;
        $assignee = $reassigned ? $this->assignableUser($newAssigneeId) : null;

        DB::transaction(function () use ($task, $changes, $assignee) {
            if (isset($changes['title'])) {
                $task->title = trim($changes['title']);
            }
            if (isset($changes['visibility'])) {
                $task->visibility = $changes['visibility'];
            }
            if ($assignee !== null) {
                $this->lockOwner($assignee);
                $this->ensureInboxRoom($assignee);

                $task->previousAssigneeId = $task->assignee_id;
                $task->assignee_id = $assignee->id;
                $task->list_id = null;
                $task->position = $this->nextPosition($assignee, null);
            }
            $task->save();
        });

        return $task;
    }

    /** Ticking again keeps the first completion time. */
    public function setCompleted(Task $task, bool $done): Task
    {
        $task->completed_at = $done ? ($task->completed_at ?? now()) : null;
        $task->save();

        return $task;
    }

    public function deleteTask(Task $task): void
    {
        $task->delete();
    }

    /** A person who exists and is not banned, else `invalid_assignee`. */
    private function assignableUser(int $id): User
    {
        $user = User::find($id);
        if ($user === null || $user->isBanned()) {
            throw new TaskRefused('invalid_assignee');
        }

        return $user;
    }

    /** The tasks a person holds in a list, or in their inbox (no list). @return Builder<Task> */
    private function placeQuery(User $assignee, ?int $listId): Builder
    {
        return Task::where('assignee_id', $assignee->id)->where('list_id', $listId);
    }

    /** Call with the assignee locked. */
    private function ensureInboxRoom(User $assignee): void
    {
        if ($this->placeQuery($assignee, null)->count() >= self::MAX_INBOX) {
            throw new TaskRefused('inbox_full');
        }
    }

    private function nextPosition(User $assignee, ?int $listId): int
    {
        $last = $this->placeQuery($assignee, $listId)->max('position');

        return $last === null ? 0 : $last + 1;
    }

    /** Serializes a person's list and task changes, so two requests cannot both pass a cap or take the same position. */
    private function lockOwner(User $owner): void
    {
        User::whereKey($owner->id)->lockForUpdate()->first();
    }
}
