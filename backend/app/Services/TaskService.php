<?php

namespace App\Services;

use App\Events\TaskChanged;
use App\Exceptions\TaskRefused;
use App\Models\Task;
use App\Models\TaskList;
use App\Models\User;
use App\Models\Workspace;
use App\Services\Push\PushNotifier;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Throwable;

/** The rules for task lists and tasks. Controllers validate and authorize; this decides. */
class TaskService
{
    public const MAX_LISTS = 50;

    public const MAX_TASKS_PER_LIST = 500;

    public const MAX_INBOX = 200;

    public function __construct(private readonly PushNotifier $push) {}

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
            // Each affected person is told once, about the first affected task that concerns them.
            $told = [];
            foreach (Task::where('list_id', $list->id)->orderBy('id')->get(['id', 'creator_id', 'assignee_id']) as $task) {
                $people = array_diff([$task->creator_id, $task->assignee_id], $told);
                $this->notify($task->id, $people);
                $told = [...$told, ...$people];
            }

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
            $this->announce($task);
            $this->pushAssignment($task, $by);

            return $task;
        });
    }

    /**
     * Applies `title`, `visibility` and/or `assignee_id`. A new assignee gets the task in their inbox (no list,
     * last place) and the returned model's `previousAssigneeId` holds the former one; it stays null when the assignee
     * did not change. Decides on the task as it is once its holder (or the person named) is locked, never on the
     * caller's copy: returns that fresh model.
     *
     * @param  array{title?: string, visibility?: string, assignee_id?: int|null}  $changes
     */
    public function updateTask(Task $task, array $changes): Task
    {
        $task->previousAssigneeId = null;
        $newAssigneeId = isset($changes['assignee_id']) ? (int) $changes['assignee_id'] : null;
        if ($newAssigneeId !== null && $newAssigneeId !== $task->assignee_id) {
            // Refused before anything is locked: an unknown id has no row to lock.
            $this->assignableUser($newAssigneeId);
        }

        return DB::transaction(function () use ($task, $changes, $newAssigneeId) {
            // Person first, then the task, like moveTask: whoever will hold it, so a cap and a position are decided under lock.
            $this->lockOwner($newAssigneeId ?? $task->assignee_id);
            $task = Task::whereKey($task->id)->lockForUpdate()->firstOrFail();
            $assignee = $newAssigneeId !== null && $newAssigneeId !== $task->assignee_id ? $this->assignableUser($newAssigneeId) : null;

            if (isset($changes['title'])) {
                $task->title = trim($changes['title']);
            }
            if (isset($changes['visibility'])) {
                $task->visibility = $changes['visibility'];
            }
            if ($assignee !== null) {
                $this->ensureInboxRoom($assignee);

                $task->previousAssigneeId = $task->assignee_id;
                $task->assignee_id = $assignee->id;
                $task->list_id = null;
                $task->position = $this->nextPosition($assignee, null);
            }
            $task->save();
            $this->announce($task);
            if ($assignee !== null) {
                // Changing the assignee is the creator's alone (TaskPolicy::edit).
                $this->pushAssignment($task, $task->creator);
            }

            return $task;
        });
    }

    /** Ticking again keeps the first completion time. */
    public function setCompleted(Task $task, bool $done): Task
    {
        $task->completed_at = $done ? ($task->completed_at ?? now()) : null;
        $task->save();
        $this->announce($task);

        return $task;
    }

    public function deleteTask(Task $task): void
    {
        $task->delete();
        $this->announce($task);
    }

    /**
     * The assignee files the task into one of their lists (last place), or back into their inbox with `null`.
     * Already being there is not a change, so it is never refused by a cap. Decides on the task as it is once the
     * assignee is locked: if it changed hands since the caller was authorized, that is a 403.
     */
    public function moveTask(Task $task, ?int $listId): Task
    {
        return DB::transaction(function () use ($task, $listId) {
            $assignee = $this->lockOwner($task->assignee_id);
            $task = $this->lockedHeldBy($task, $assignee->id);

            if ($task->list_id === $listId) {
                return $task;
            }

            if ($listId === null) {
                $this->ensureInboxRoom($assignee);
            } else {
                TaskList::where('user_id', $assignee->id)->find($listId) ?? throw new TaskRefused('invalid_list');
                if ($this->placeQuery($assignee, $listId)->count() >= self::MAX_TASKS_PER_LIST) {
                    throw new TaskRefused('task_limit');
                }
            }

            $task->list_id = $listId;
            $task->position = $this->nextPosition($assignee, $listId);
            $task->save();
            $this->announce($task);

            return $task;
        });
    }

    /**
     * The assignee gives the task back: it goes to its creator's inbox, last place, and `$task->previousAssigneeId`
     * holds who returned it. A creator who holds their own task has nothing to return (403, like a stale caller).
     */
    public function returnToAuthor(Task $task): Task
    {
        return DB::transaction(function () use ($task) {
            $author = $this->lockOwner($task->creator_id);
            $heldBy = $task->assignee_id;
            $task = $this->lockedHeldBy($task, $heldBy);
            if ($heldBy === $author->id) {
                throw new AuthorizationException;
            }
            $this->ensureInboxRoom($author);

            $task->previousAssigneeId = $heldBy;
            $task->assignee_id = $author->id;
            $task->list_id = null;
            $task->position = $this->nextPosition($author, null);
            $task->save();
            $this->announce($task);
            $this->pushAssignment($task, User::findOrFail($heldBy));

            return $task;
        });
    }

    /**
     * The demo reset's share of the content: the tasks demo accounts created go (even held by a `member` or a `seed` account:
     * visitor content), then the lists they own. A task someone else created that sat in one of those lists goes back to its
     * author, in their inbox (spec §10), whether the demo account survives or not; one already unfiled stays with its holder.
     * Bulk and silent: no announcement, no push (the next load shows it). Call it inside the reset's transaction.
     *
     * @param  Collection<int, int>  $demoIds
     * @return array{deleted_tasks: int, deleted_task_lists: int}
     */
    public function wipeDemoContent(Collection $demoIds): array
    {
        $deletedTasks = Task::whereIn('creator_id', $demoIds)->delete();
        // What is left in demo lists was created by others (the demo accounts' own tasks are gone).
        Task::whereIn('list_id', TaskList::whereIn('user_id', $demoIds)->select('id'))
            ->update(['assignee_id' => DB::raw('creator_id'), 'list_id' => null]);

        return ['deleted_tasks' => $deletedTasks, 'deleted_task_lists' => TaskList::whereIn('user_id', $demoIds)->delete()];
    }

    /**
     * Gives back to their author the tasks others gave the accounts about to be deleted: `assignee_id = creator_id`, in the inbox.
     * An account deleted through the query builder fires no model event, so the reset calls this itself, before the delete
     * (the foreign key would otherwise take the tasks with the account). Bulk and silent, like wipeDemoContent.
     *
     * @param  Collection<int, int>  $userIds
     */
    public function releaseTasksOf(Collection $userIds): void
    {
        Task::whereIn('assignee_id', $userIds)->whereColumn('creator_id', '!=', 'assignee_id')
            ->update(['assignee_id' => DB::raw('creator_id'), 'list_id' => null]);
    }

    /**
     * Tells everyone concerned that the task changed: its creator, its assignee, the one who held it before
     * (`$task->previousAssigneeId`) and `$alsoUserId`, once each. Held back until the transaction commits.
     */
    public function announce(Task $task, ?int $alsoUserId = null): void
    {
        $this->notify($task->id, [$task->creator_id, $task->assignee_id, $task->previousAssigneeId, $alsoUserId]);
    }

    /**
     * Web Push to the new assignee, once the transaction committed (nothing if it is rolled back). A failure is reported,
     * never thrown: the task is saved and its author gets their answer.
     */
    private function pushAssignment(Task $task, User $by): void
    {
        DB::afterCommit(function () use ($task, $by) {
            try {
                $this->push->taskAssigned($task, $by);
            } catch (Throwable $e) {
                report($e);
            }
        });
    }

    /** @param  array<int|null>  $userIds */
    private function notify(int $taskId, array $userIds): void
    {
        foreach (array_unique(array_filter($userIds)) as $userId) {
            TaskChanged::dispatch($taskId, $userId);
        }
    }

    /** The task has to exist and still be held by `$assigneeId`, as the caller was authorized against. */
    private function lockedHeldBy(Task $task, int $assigneeId): Task
    {
        $fresh = Task::whereKey($task->id)->lockForUpdate()->firstOrFail();
        if ($fresh->assignee_id !== $assigneeId) {
            throw new AuthorizationException;
        }

        return $fresh;
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
    private function lockOwner(User|int $owner): User
    {
        return User::whereKey($owner instanceof User ? $owner->id : $owner)->lockForUpdate()->firstOrFail();
    }
}
