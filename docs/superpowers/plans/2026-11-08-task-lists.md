# Task Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a task-lists module to Slax: several named lists per person, tasks public or private, assignment to a colleague, moving tasks between lists, and a read-only view of a colleague's visible tasks.

**Architecture:** Two tables (`task_lists`, `tasks`) behind a thin REST API (`/api/v1`), with the rules in one service (`App\Services\Tasks\TaskService`) and access in two policies, 404 for what the caller may not see. Changes are announced on the existing personal channel `App.Models.User.{id}` (ids only; the client refetches over REST), and an assignment sends a Web Push. The Preact frontend gets a `/tasks/...` area, a sidebar section, a `store/tasks.ts` and the same i18n/RTL/theme rules as the rest.

**Tech Stack:** Laravel (Pest, Policies, Resources, Reverb), PostgreSQL, Preact + `@preact/signals` + Vitest, Playwright (e2e), Docker/Make.

**Spec:** `docs/superpowers/specs/2026-11-08-task-lists-design.md` (§ numbers below refer to it). Read it first.

## Global Constraints

- Lists: ≤ **50** per person (`task_list_limit`); name ≤ **60** characters. Tasks: ≤ **500** per list (`task_limit`), ≤ **200** unfiled tasks per person (`inbox_full`, refused when assigning to a full inbox); title ≤ **200** characters (characters, not bytes: Hebrew counts one per letter), trimmed, not empty; no notes, no dates.
- Visibility is per task: `public` | `private`. The create form's starting value is **private**, shown and required.
- An invisible task or list answers **404**, never 403 (`ChannelPolicy` style). A visible task the caller may not change answers 403.
- A refusal by rule is `422` with `{"error": "<code>"}` (codes: `task_list_limit`, `task_limit`, `inbox_full`, `invalid_assignee`, `invalid_list`).
- `list_id`, when set, is always a list of the **assignee**. Changing the assignee clears `list_id`.
- "Assignées à moi" = assignee is me AND `list_id` is null. "Assignées par moi" = creator is me AND assignee is not me.
- Banned accounts: never offered as assignee (`invalid_assignee`), their task page is 404, no push to them; a ban changes no data.
- Administrators get no special access to private tasks.
- Push never carries a task title (`type, title, body, url, tag` only; url `/tasks/inbox`, new `type` = `task`).
- Broadcast payloads carry ids only (`task.changed` → `{"task_id": int}`).
- Frontend: CSS logical properties only (a test rejects `left/right`), three languages `en`/`he`/`fr` with identical keys, both themes, drawer on narrow screens.
- API shapes are bare JSON (no `data` wrapper). Backend code style: Pint (`make lint`).
- Commits: `git -c user.name=yechpa -c user.email=yechpa@gmail.com commit ...`, message ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push, never open a PR, never touch prod: the user does that.

## Review Focus

Failure modes the spec implies that no single task's happy path exercises (each gets a named test in the task that owns the code):

1. A private task leaking through a path other than the obvious one: a colleague's page, "by me", a list *name* when the list holds only private tasks (Task 5), the broadcast payload (Task 6), the push (Task 7).
2. A task landing in a list that is not the assignee's: `list_id` of someone else's list at creation and at move, or kept after reassignment (Tasks 3, 4).
3. Losing access on change: flipping public → private, or reassigning a private task, must hide it from people who saw it, on their next fetch (Tasks 4, 5).
4. Titles and names: 200 Hebrew letters accepted, 201 refused, whitespace-only refused, surrounding spaces trimmed, RTL and emoji kept intact (Task 3).
5. Completed tasks: still count toward the 500 cap, leave the "to file" count, stay visible per the visibility rules (Tasks 3, 5, 11).

## Commands (used by every task)

Once per shell: `export DOCKER_UID=$(id -u) DOCKER_GID=$(id -g)`. First time only: `make deps`, then `make test` once (it creates the `slax_test` database).

- Backend, one file: `docker compose --progress quiet up -d --wait postgres redis && docker compose --progress quiet run --rm -T app vendor/bin/pest tests/Feature/<File>.php`
- Frontend, one file: `docker compose --progress quiet run --rm -T --no-deps frontend npx vitest run src/<path>`
- Whole gates: `make test` and `make lint`; `make e2e` for Playwright.

---

## File map

Backend (new unless noted): `database/migrations/2026_11_08_100000_create_task_lists_and_tasks_tables.php`; `app/Models/{TaskList,Task}.php`; `database/factories/{TaskListFactory,TaskFactory}.php`; `app/Policies/{TaskListPolicy,TaskPolicy}.php`; `app/Services/Tasks/TaskService.php`; `app/Exceptions/TaskRefused.php`; `app/Http/Controllers/{TaskListController,TaskController,UserTaskController}.php`; `app/Http/Resources/{TaskListResource,TaskResource}.php`; `app/Events/TaskChanged.php`; modified: `routes/api.php`, `app/Providers/AppServiceProvider.php` (route patterns, `tasks` limiter, policies if not auto-discovered), `bootstrap/app.php` (render `TaskRefused`), `app/Services/Push/{PushPayload,PushNotifier}.php`, `lang/{en,fr,he}/push.php`, `app/Console/Commands/DemoReset.php`, `database/seeders/DemoSeeder.php`. Tests: `tests/Feature/Task{Lists,Write,Read,Realtime,Push,DemoReset}Test.php`.

Frontend (new unless noted): `src/store/tasks.ts`, `src/components/tasks/{TasksPage,TaskListView,TaskRow,NewTaskForm,TaskMenu,ListDialogs,MoveTaskDialog,AssignDialog,ColleagueTasks,TasksSidebar}.tsx`, `src/styles/tasks.css`; modified: `src/api/{types,endpoints}.ts`, `src/router.ts`, `src/store/chat.ts`, `src/components/{Workspace,Sidebar}.tsx`, `src/styles/index.css`, `src/i18n/{en,fr,he}.json`. Tests beside each. E2E: `e2e/tests/tasks.spec.ts`. Docs: `README.md`, `docs/{architecture,family-guide,recette,known-limitations}.md`.

---

### Task 1: Tables, models, factories

**Files:** Create the migration, `TaskList.php`, `Task.php`, the two factories. Test: `tests/Feature/TaskModelTest.php`.

**Interfaces — Produces:**
- Table `task_lists`: `id`, `workspace_id` (FK), `user_id` (FK cascade), `name` string(60), `position` unsigned int default 0, timestamps, index `(user_id, position)`.
- Table `tasks`: `id`, `workspace_id`, `creator_id` (FK users, cascade), `assignee_id` (FK users, cascade), `list_id` nullable (FK `task_lists`, `nullOnDelete`), `title` string(200), `visibility` string(8) default `private`, `completed_at` nullable, `position` unsigned int default 0, timestamps; indexes `(assignee_id, list_id)`, `(creator_id)`.
- `Task::PUBLIC = 'public'`, `Task::PRIVATE = 'private'`; relations `creator()`, `assignee()`, `list()`; `isCompleted(): bool`.
- `Task::scopeVisibleTo(Builder $q, User $viewer): Builder` — public tasks, plus tasks where the viewer is creator or assignee.
- `Task::isVisibleTo(User $viewer): bool` (same rule).
- `TaskList`: `owner()`, `tasks()`; factories default to the default workspace like `ChannelFactory`; `TaskFactory` states `public()`, `private()`, `completed()`, `unfiled()`, `assignedTo(User)`.

- [ ] **Step 1: Write failing tests** in `TaskModelTest.php`: `visibleTo returns public tasks and private ones the viewer created or holds, nothing else` (alice private for bob, carol public by dave; assert for alice, bob, carol, dave exact id sets); `deleting a user deletes the tasks they created`; `deleting a list leaves its tasks unfiled at the database level` (net only; the real rule is Task 2).
- [ ] **Step 2: Run, expect FAIL** (class/table missing).
- [ ] **Step 3: Implement** the migration (dated `2026_11_08_100000`), models (`$fillable` without privileged columns), factories, `scopeVisibleTo`/`isVisibleTo`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** (also adds `docs/superpowers/specs/2026-11-08-task-lists-design.md` and this plan): `feat(tasks): task lists and tasks tables`.

---

### Task 2: Lists API and the TaskService skeleton

**Files:** Create `TaskListController`, `TaskListPolicy`, `TaskListResource`, `TaskRefused`, `TaskService`; modify `routes/api.php`, `AppServiceProvider.php` (`Route::pattern('taskList','[0-9]+')`, `Route::pattern('task','[0-9]+')`, `RateLimiter::for('tasks', 60/min per user)`), `bootstrap/app.php`. Test: `tests/Feature/TaskListsTest.php`.

**Interfaces — Produces:**
- `TaskRefused extends RuntimeException` with the error code as message; rendered as `422 {"error": code}` (follow how `FileRejected` is rendered in `bootstrap/app.php`).
- `TaskService::createList(User $owner, string $name): TaskList` (cap 50 → `TaskRefused('task_list_limit')`; `position` = last + 1); `renameList(TaskList $list, string $name): TaskList`; `moveList(TaskList $list, int $position): void` (reorders the owner's lists contiguously); `deleteList(TaskList $list): void` — in a transaction: tasks of the list whose `creator_id` = owner are deleted, the others get `list_id = null`, then the list goes; `ensureDefaultList(User $owner): TaskList` — returns the first list, or creates one named by `__('tasks.default_list', [], $owner->locale)` (add key `default_list` to `lang/{en,fr,he}/tasks.php`: "My tasks" / "Mes tâches" / "המשימות שלי").
- Routes (inside the `auth:sanctum`, `not-banned` group, writes with `throttle:tasks`): `GET /task-lists` → `[{id, name, position, open_count}]` (`open_count` = uncompleted tasks assigned to the owner in that list); `POST /task-lists {name}` → 201; `PATCH /task-lists/{taskList} {name?, position?}`; `DELETE /task-lists/{taskList}` → 204. Other people's list on PATCH/DELETE → 404.
- `TaskListPolicy`: `manage(User, TaskList)` → owner, else `Response::denyAsNotFound()`.

- [ ] **Step 1: Write failing tests**: `lists are personal: index shows only mine, in position order, with open_count`; `a name is trimmed, 1 to 60 characters, Hebrew and emoji kept`; `the 51st list is refused with task_list_limit`; `someone else's list answers 404 on rename, reorder and delete`; `deleting a list deletes the tasks I wrote in it and returns the ones others gave me to my inbox`; `ensureDefaultList creates "My tasks" once, in the owner's locale`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** as above. Thin controllers: validate, authorize via `Gate::authorize('manage', $list)`, call the service.
- [ ] **Step 4: Run `TaskListsTest.php` and `RealtimeTest.php` (unchanged), expect PASS.**
- [ ] **Step 5: Commit** `feat(tasks): lists API`.

---

### Task 3: Task writes (create, edit, complete, delete)

**Files:** Create `TaskController` (writes only), `TaskPolicy`, `TaskResource`; extend `TaskService`; modify `routes/api.php`. Test: `tests/Feature/TaskWriteTest.php`.

**Interfaces — Consumes:** Task 1 models, Task 2 `TaskService::ensureDefaultList`, `TaskRefused`.

**Interfaces — Produces:**
- `TaskResource` JSON: `{id, title, visibility, completed: bool, completed_at, list_id, position, creator: {id, name, avatar_url}, assignee: {id, name, avatar_url}, created_at}`. Never an e-mail address.
- `TaskService::createTask(User $by, string $title, string $visibility, ?int $listId, ?int $assigneeId): Task` — assignee defaults to `$by`. Self-assigned: list is `$listId` (must be mine, else `invalid_list`; absent → `ensureDefaultList`), cap 500 per list counting completed tasks (`task_limit`). Assigned to someone else: no list (`list_id` ignored), assignee must exist, not be banned (`invalid_assignee`), inbox of the assignee ≤ 200 unfiled tasks (`inbox_full`). Title is trimmed; `position` = last in the destination + 1.
- `TaskService::updateTask(Task $task, array $changes): Task` — `title`, `visibility`, `assignee_id`. Changing the assignee clears `list_id`, applies the same assignee rules, and records `previousAssigneeId` on the returned model (`$task->previousAssigneeId`, a plain property) for Tasks 6–7.
- `TaskService::setCompleted(Task $task, bool $done): Task`; `TaskService::deleteTask(Task $task): void`.
- Routes: `POST /tasks {title, visibility, list_id?, assignee_id?}` → 201; `PATCH /tasks/{task} {title?, visibility?, assignee_id?}` (creator only); `PUT /tasks/{task}/completion {completed: bool}` (creator or assignee); `DELETE /tasks/{task}` → 204 (creator only). All `throttle:tasks`.
- `TaskPolicy`: `view` (invisible → `denyAsNotFound`), `edit` (creator; visible-but-not-creator → deny 403), `complete` (creator or assignee), `delete` (creator).

- [ ] **Step 1: Write failing tests**: `create for myself lands in the given list, or in "My tasks" when I have none`; `visibility is required and only public or private`; `create for a colleague puts it in their inbox with no list and ignores list_id`; `list_id of someone else's list is refused with invalid_list`; `a banned or unknown assignee is refused with invalid_assignee`; `a colleague with 200 unfiled tasks refuses a 201st with inbox_full`; `the 501st task of a list is refused with task_limit, completed ones included`; `a title of 200 Hebrew letters is accepted and 201 refused; blank and whitespace-only refused; trimmed`; `only the creator edits, reassigns or deletes: the assignee gets 403 on a public task and 404 on a stranger's private one`; `reassigning clears the list and the former assignee loses a private task`; `creator and assignee may complete and reopen, a stranger may not`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Count checks inside the transaction with `lockForUpdate` on the owner's `task_lists` row (or the assignee `users` row for the inbox) so two requests cannot both pass the cap.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(tasks): create, edit, complete and delete tasks`.

---

### Task 4: Move and return to author

**Files:** Modify `TaskController`, `TaskService`, `TaskPolicy`, `routes/api.php`. Test: `tests/Feature/TaskMoveTest.php`.

**Interfaces — Produces:**
- `TaskService::moveTask(Task $task, ?int $listId): Task` — assignee only; `listId` must belong to the assignee (else `invalid_list`), cap 500 (`task_limit`); `null` puts it back unfiled (inbox cap 200 → `inbox_full`).
- `TaskService::returnToAuthor(Task $task): Task` — assignee ≠ creator; sets `assignee_id = creator_id`, `list_id = null`; the creator's inbox cap applies (`inbox_full`).
- Routes: `POST /tasks/{task}/move {list_id: int|null}`, `POST /tasks/{task}/return`. Policy abilities `move` and `return` = the assignee; a visible task for anyone else → 403, invisible → 404.

- [ ] **Step 1: Write failing tests**: `the assignee files an inbox task into one of their lists and it leaves the inbox`; `a task cannot be moved into someone else's list (invalid_list), nor by someone who is not the assignee`; `moving to null puts it back in the inbox`; `moving into a list of 500 is refused`; `returning to the author puts it in the author's inbox; the creator cannot return their own task`; `after a return the former assignee no longer sees a private task`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(tasks): move between lists, return to author`.

---

### Task 5: Read endpoints

**Files:** Create `UserTaskController`; extend `TaskListController` and `TaskController`; modify `routes/api.php`. Test: `tests/Feature/TaskReadTest.php`.

**Interfaces — Produces** (all `auth:sanctum`, `not-banned`; resources as in Task 3, ordered by `position`, `id`; completed tasks included with `completed: true`, clients place them):
- `GET /task-lists/{taskList}/tasks` → `Task[]` — owner only (other → 404): tasks assigned to the owner in that list, **all** of them (the owner is assignee or creator-assignee, so all are visible to them).
- `GET /tasks/inbox` → `Task[]` — assigned to me, `list_id` null (≤ 200).
- `GET /tasks/by-me` → `Task[]` — created by me, assigned to someone else.
- `GET /users/{user}/tasks` (`whereNumber('user')`) → `{user: {id, name, avatar_url}, lists: [{id, name, tasks: Task[]}], unfiled: Task[]}` containing, per spec §6, the tasks assigned to that person and visible to me (`Task::visibleTo`); a list with no visible task is **omitted** (name not revealed); a banned or unknown user → 404; my own id works and shows everything of mine.

- [ ] **Step 1: Write failing tests**: `a colleague's page shows public tasks, plus private ones I created for them, grouped by list, with unfiled ones apart`; `a list holding only private tasks is absent from a colleague's page, name included`; `a stranger never sees a private task through any endpoint (lists, inbox, by-me, user page)` (loop over the four endpoints with a stranger and assert the title appears nowhere in the JSON); `after a public task is made private it disappears from the colleague's page on the next fetch`; `inbox and by-me show the right tasks and nothing else, completed ones included`; `a banned colleague's page answers 404`; `someone else's list tasks answer 404`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with `visibleTo`; eager load `creator` and `assignee` (no N+1: assert query count stays constant in one test).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(tasks): read endpoints and colleague page`.

---

### Task 6: Realtime event

**Files:** Create `app/Events/TaskChanged.php`; modify `TaskService` / controllers to dispatch. Test: `tests/Feature/TaskRealtimeTest.php`.

**Interfaces — Produces:** `TaskChanged implements ShouldBroadcast, ShouldDispatchAfterCommit` (copy `ChannelAdded`): `__construct(public int $taskId, public int $userId)`, `broadcastAs() = 'task.changed'`, `broadcastOn() = [PrivateChannel("App.Models.User.{userId}")]`, `broadcastWith() = ['task_id' => $taskId]`. `TaskService::announce(Task $task, ?int $alsoUserId = null): void` dispatches one event per distinct user among creator, assignee, and `$task->previousAssigneeId`; called after create, update, completion, move, return, delete (for delete, capture the ids before deleting).

- [ ] **Step 1: Write failing tests** (`Event::fake`): `create for a colleague notifies creator and assignee once each`; `reassigning also notifies the former assignee`; `deleting a task notifies both`; `the payload is exactly {task_id} and the channel is the user's own private channel` (also assert `broadcastWith()` contains neither the title nor the visibility); `no event for a rejected request`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement and call `announce` from the Task 2–4 write paths.**
- [ ] **Step 4: Run the whole `tests/Feature` directory for tasks plus `RealtimeTest.php`, expect PASS.**
- [ ] **Step 5: Commit** `feat(tasks): task.changed event`.

---

### Task 7: Push on assignment

**Files:** Modify `app/Services/Push/PushPayload.php`, `PushNotifier.php`, `lang/{en,fr,he}/push.php`, `TaskService` (call after commit). Read `app/Jobs/SendPushNotification.php` first. Test: `tests/Feature/TaskPushTest.php` (reuse the helpers at the top of `PushNotificationTest.php`: move `device()` to `tests/Pest.php` if needed, without changing its behavior).

**Interfaces — Produces:**
- `PushPayload::TYPE_TASK = 'task'`; `PushPayload::forTask(User $sender, string $locale): array` → `type 'task'`, `title` = `__('push.title_task', ['sender' => name])` (same e-mail-name rule as `senderName`), `body` = `__('push.body_task')`, `url '/tasks/inbox'`, `tag 'tasks'`. Strings: en "`:sender` assigned you a task" / "New task"; fr "`:sender` t'a assigné une tâche" / "Nouvelle tâche"; he ":sender הקצה לך משימה" / "משימה חדשה".
- `PushNotifier::taskAssigned(Task $task, User $by): int` — nothing when push is off, when assignee is `$by`, banned, or `online` (same rule as `messageCreated`); otherwise one `SendPushNotification::dispatch($device->id, null, null, $payload)` per device. Confirm the job treats `channelId`/`messageId` null as "no membership check" for non-test payloads, and add that if it only does so for the `test` type; keep the ban re-check.
- Called after commit on create-for-colleague, reassignment, and return to author (to the creator). Failures are reported and swallowed (like `QueuePushNotifications`).

- [ ] **Step 1: Write failing tests**: `assigning to an away colleague queues one push per device with type task, url /tasks/inbox, in the device's language`; `the payload contains no title of the task` (title set to a unique string, assert absent from every payload value); `nothing for self-assignment, for an online colleague, for a banned one`; `reassignment and return notify the new holder`; `a push failure does not fail the request`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `TaskPushTest.php` and `PushNotificationTest.php`, expect PASS.**
- [ ] **Step 5: Commit** `feat(tasks): push on assignment`.

---

### Task 8: Demo reset, seed, account deletion

**Files:** Modify `app/Console/Commands/DemoReset.php`, `database/seeders/DemoSeeder.php`, `TaskService` (add `TaskService::releaseTasksOf(Collection $userIds): void` and `wipeDemoContent(Collection $demoIds): array{deleted_tasks:int, deleted_task_lists:int}`). Test: `tests/Feature/TaskDemoResetTest.php` (follow `DemoResetTest.php`).

**Interfaces — Produces:**
- `wipeDemoContent(Collection $demoIds)`: deletes tasks created by those accounts; then for lists they own, unfiles the remaining tasks (created by others) and deletes the lists. Called inside the existing `DB::transaction` of `DemoReset`, **before** users are deleted; its two counts join the summary (`deleted_tasks`, `deleted_task_lists`).
- `releaseTasksOf(Collection $userIds)`: for tasks assigned to those users and created by someone else, set `assignee_id = creator_id`, `list_id = null`. Called in `DemoReset` for the users actually deleted (`$users->modelKeys()`), before `User::...->delete()` (a query-builder delete fires no model event, which is why this is explicit). Grep the backend for any other user-deletion path; if one exists, call it there too.
- `DemoSeeder` restores, idempotently (match on `creator_id`+`title`, `user_id`+`name`), a few lists and tasks for the seed people: public and private ones, one task assigned from one seed person to another (in the inbox); add public constants `TASK_LISTS` and `TASKS` next to `MESSAGES`.

- [ ] **Step 1: Write failing tests**: `the reset deletes tasks and lists of demo accounts, including surviving ones`; `a member's task that sat in a demo list returns to the member's inbox`; `a task a member gave a deleted demo account returns to the member, one given to a surviving demo account stays`; `seed tasks are restored without duplicates when the seeder or the reset runs twice`; `the summary reports deleted_tasks and deleted_task_lists`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `TaskDemoResetTest.php` and `DemoResetTest.php`, expect PASS.**
- [ ] **Step 5: Commit** `feat(tasks): demo reset, seed and account deletion`.

---

### Task 9: Frontend data layer (types, API, router, store)

**Files:** Modify `src/api/types.ts`, `src/api/endpoints.ts`, `src/router.ts`; create `src/store/tasks.ts`; tests `src/store/tasks.test.ts`, extend router tests (find them with `grep -l parseRoute src -r`).

**Interfaces — Produces:**
- Types: `TaskVisibility = 'public'|'private'`; `Task` and `TaskList` mirroring Task 2–3 JSON; `ColleagueTasks = {user: UserSummary; lists: {id:number; name:string; tasks:Task[]}[]; unfiled: Task[]}`.
- `api.tasks = { lists(), createList(name), renameList(id,name), moveList(id,position), deleteList(id), listTasks(id), inbox(), byMe(), ofUser(id), create({title, visibility, list_id?, assignee_id?}), update(id, changes), setCompleted(id, completed), move(id, listId|null), returnToAuthor(id), remove(id) }` (paths of Tasks 2–5, `signal?` where reads).
- Router: `Route` gains `{ name: 'tasks'; view: TasksView }` with `TasksView = {kind:'inbox'} | {kind:'by-me'} | {kind:'list'; id:number} | {kind:'user'; id:number}`; `/tasks` and `/tasks/inbox` → inbox, `/tasks/by-me`, `/tasks/l/:id`, `/tasks/u/:id`; helpers `tasksPath(view)`; update the file's header comment; `interceptLinks` must treat them as known.
- `store/tasks.ts` (module-level signals, reset function, like `store/channels.ts`): `taskLists`, `inbox`, `tasksLoaded`, `inboxToFile = computed(count of inbox tasks not completed)`, `tasksVersion` (incremented by each refresh), `loadTasks()` (lists + inbox), `refreshTasks()` (same, bumps `tasksVersion`, swallows errors), `resetTasks()`.

- [ ] **Step 1: Write failing tests**: `parseRoute maps /tasks, /tasks/inbox, /tasks/by-me, /tasks/l/12, /tasks/u/7 and rejects /tasks/l/abc and /tasks/l/0`; `tasksPath round-trips parseRoute`; `loadTasks fills lists and inbox and inboxToFile ignores completed tasks` (use `fakeFetch`); `refreshTasks bumps tasksVersion and keeps the old data when the request fails`; `resetTasks empties everything` (on sign-out, call it where `resetChannels` is called).
- [ ] **Step 2: Run (`src/store/tasks.test.ts src/router`), expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(tasks): frontend data layer`.

---

### Task 10: Live updates in the chat controller

**Files:** Modify `src/store/chat.ts` (`subscribePersonal`), `src/components/Workspace.tsx` (initial `loadTasks()` when the session starts). Test: extend `src/store/chat.test.ts` next to "the user's own channel (channel.added)".

**Interfaces — Consumes:** `refreshTasks` from Task 9. **Produces:** the personal subscription also binds `'task.changed'`, debounced like `onChannelAdded` (reuse the same debounce constant) and calling `refreshTasks()`; the same minute poll that refreshes channels also refreshes tasks while visible (add to the existing `pollWhileVisible` in `Workspace`).

- [ ] **Step 1: Write failing tests**: `a task.changed on my channel refreshes tasks once for a burst of three`; `after reconnect the tasks are refreshed too`; `a task.changed on someone else's channel does nothing` (mirror the `channel.added` tests).
- [ ] **Step 2: Run `src/store/chat.test.ts`, expect FAIL.**
- [ ] **Step 3: Implement** (`reconnect()` calls `refreshTasks()` beside `refreshChannels()`).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(tasks): live task updates`.

---

### Task 11: Tasks area UI — sidebar, pages, task rows, create form

**Files:** Create `src/components/tasks/{TasksSidebar,TasksPage,TaskListView,TaskRow,NewTaskForm,TaskMenu}.tsx`, `src/styles/tasks.css` (import in `styles/index.css`); modify `Sidebar.tsx` (render `<TasksSidebar/>` under direct messages), `Workspace.tsx` (the `Shell`: `route.name === 'tasks'` → `<TasksPage/>`, exclude `tasks` from the "open a default channel" effect, `aria-labelledby` as for admin), `i18n/{en,fr,he}.json` (keys prefixed `tasks.` and `nav.tasks`). Tests: `TasksSidebar.test.tsx`, `TasksPage.test.tsx`, `TaskRow.test.tsx` (patterns of `Sidebar.test.tsx`; `fakeFetch`; `ME`, `NOAM`, `DANA` fixtures).

**Interfaces — Consumes:** Task 9. **Produces:**
- `TasksSidebar`: heading "tasks"; rows `Assignées à moi` (badge = `inboxToFile`), `Assignées par moi`, one row per list (name, `open_count` hint), `+ New list` (opens the list dialog of Task 12), `> People's tasks` (opens the picker dialog of Task 12). Links use `tasksPath`.
- `TasksPage` picks the view from `route`; each view has the same header as `ChannelView` (nav toggle for the drawer, `id="channel-title"`).
- `TaskListView` (own list, inbox, by-me): loads on mount and when `tasksVersion` changes; open tasks first, completed under a collapsible "Done (n)" section, struck through; empty and error states with `EmptyState` and a Retry button.
- `TaskRow`: checkbox (`aria-label` with the title) toggling `api.tasks.setCompleted` (optimistic, rolls back with a toast on error); title with `dir="auto"`; a small public/private indicator; creator or assignee chip when not me; `TaskMenu` button.
- `NewTaskForm` (top of own lists): title field, `Segmented` public/private (**starting at private**, labelled), "Assign to" via `PeoplePicker` (me by default; a chosen person hides the list choice and shows a hint that it goes to their inbox). Errors from the server (`task_limit`, `inbox_full`, `invalid_assignee`) are said in the reader's language.
- `TaskMenu` (a `Popover`): rename/retitle, change visibility, assign to… (Task 12), move to… (Task 12), return to author, delete — each shown only when the viewer may do it (rules of spec §6 mirrored client-side; the server still decides).

- [ ] **Step 1: Write failing tests**: `the sidebar lists inbox, by-me and my lists, and the badge counts uncompleted inbox tasks only`; `creating a task sends visibility private by default and shows it in the list`; `choosing public sends public`; `choosing a colleague as assignee sends assignee_id and no list_id`; `a server refusal (inbox_full) shows its translated message and keeps the typed title`; `ticking a task is optimistic and rolls back on failure`; `completed tasks sit under "Done" and stay struck through`; `a Hebrew title renders with dir=auto`; `the menu offers only what the viewer may do` (creator vs assignee vs creator-assignee).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Add every string in the three dictionaries (the i18n test requires identical keys). Use the design tokens and logical properties only.
- [ ] **Step 4: Run these tests, `src/i18n`, `src/styles`, `Sidebar.test.tsx`, expect PASS.**
- [ ] **Step 5: Commit** `feat(tasks): tasks area`.

---

### Task 12: Dialogs, colleague page, picker entry

**Files:** Create `src/components/tasks/{ListDialogs,MoveTaskDialog,AssignDialog,ColleagueTasks}.tsx`; modify `Workspace.tsx` `Dialogs()` and `store/ui.ts` (`openDialog` gets `'new-task-list'`, `'people-tasks'`), `TasksSidebar`/`TaskMenu` wiring, i18n files. Tests beside each.

**Interfaces — Produces:**
- `ListDialogs`: `NewListDialog`, `RenameListDialog`, `DeleteListDialog` (the delete confirmation says which of the list's tasks go and which return to their inbox — spec §6); refusal `task_list_limit` translated.
- `MoveTaskDialog({task, onClose})`: radio list of my lists plus "Assignées à moi (unfiled)"; sends `api.tasks.move`; `task_limit` translated.
- `AssignDialog({task, onClose})`: `PeoplePicker` single selection (banned never offered; the directory already excludes them), sends `api.tasks.update(id, {assignee_id})`.
- `PeopleTasksDialog` (opened by the sidebar's "People's tasks"): `PeoplePicker`; choosing someone navigates to `/tasks/u/:id`.
- `ColleagueTasks` (route `user`): loads `api.tasks.ofUser`, groups by list with a "No list" group, read-only except what the viewer may do; a 404 shows the not-found `EmptyState`; refreshes on `tasksVersion`.

- [ ] **Step 1: Write failing tests**: `new list dialog creates a list and opens it`; `delete list dialog explains and sends DELETE`; `moving an inbox task into a list removes it from the inbox view`; `assigning sends assignee_id and the task leaves my list view`; `picking a colleague opens their page, which shows lists with only visible tasks`; `a 404 on a colleague's page shows not found`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new tests and `npm test` for the whole frontend (`make test`), expect PASS; `make lint` clean.**
- [ ] **Step 5: Commit** `feat(tasks): dialogs and colleague page`.

---

### Task 13: End-to-end, RTL check, documentation

**Files:** Create `e2e/tests/tasks.spec.ts`; modify `README.md` (feature list), `docs/architecture.md`, `docs/family-guide.md`, `docs/recette.md` (acceptance checklist lines for tasks), `docs/known-limitations.md`.

- [ ] **Step 1: Write the Playwright spec** using `e2e/support/app.ts` helpers (`signIn`, second `Person` for a colleague, `t(locale, key)`): `create lists, a public and a private task; the colleague sees only the public one`; `assign a task to the colleague, they get it in "Assignées à moi", file it into a list, and the author sees it under "Assignées par moi"`; `the colleague returns a task to its author`; `Hebrew: the tasks area is right to left and a Hebrew title displays correctly` (extend the loop style of `rtl.spec.ts`); one run in each theme.
- [ ] **Step 2: Run `make e2e`, expect PASS** (it builds a separate stack and removes it).
- [ ] **Step 3: Docs**: README feature bullet; architecture (tables, endpoints list, the event, the push type); family guide (how to use, public vs private, what a colleague sees); recette lines; known limitations (no dates/reminders/comments; list names visible to others when they hold a public task; administrators cannot see private tasks).
- [ ] **Step 4: Full gate**: `make test`, `make lint`, `make e2e` all pass; report any failure verbatim.
- [ ] **Step 5: Commit** `test(tasks): e2e journey; docs`.

---

## Self-review

- **Spec coverage:** §2 lists/visibility/assignment/move → Tasks 2–5, 11–12; §5 model and caps → 1–4; §6 matrix → 3–5 (policies) and 11 (menu); §7 UI and routes → 9, 11, 12; §8 realtime/push/demo/throttle → 6, 7, 8, 2; §9 tests and docs → every task, 13; §10 refinements: sans-liste group (5, 12), default list (2), return to author and inbox cap (3, 4), completed tasks (3, 5, 11), banned (3, 5, 7), demo-reset details (8), 404 on others' lists (2, 5), previous assignee event (6), push url (7), no task reordering (not built: position set at creation only).
- **Types:** `TaskService` method names used in Tasks 2→8 are `createList, renameList, moveList, deleteList, ensureDefaultList, createTask, updateTask, setCompleted, deleteTask, moveTask, returnToAuthor, announce, releaseTasksOf, wipeDemoContent`; error codes are the same five everywhere; frontend `api.tasks.*` names are used as defined in Task 9.
- **Open choice left to the builder:** exact CSS, component file splits inside `tasks/`, wording of the translated strings beyond those fixed above.
