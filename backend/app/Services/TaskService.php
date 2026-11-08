<?php

namespace App\Services;

use App\Exceptions\TaskRefused;
use App\Models\Task;
use App\Models\TaskList;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;

/** The rules for task lists (and, later, tasks). Controllers validate and authorize; this decides. */
class TaskService
{
    public const MAX_LISTS = 50;

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

    /** Serializes a person's list changes, so two requests cannot both pass the cap or take the same position. */
    private function lockOwner(User $owner): void
    {
        User::whereKey($owner->id)->lockForUpdate()->first();
    }
}
