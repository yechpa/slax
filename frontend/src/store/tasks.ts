/**
 * The caller's task lists and inbox, which the sidebar needs everywhere (list names and the
 * badge of unfiled tasks). The pages (inbox, a list, by-me, a colleague) fetch their own data
 * and refetch when `tasksVersion` changes, which every refresh bumps.
 */
import { computed, signal } from '@preact/signals'
import { api } from '../api/endpoints.ts'
import type { Task, TaskList } from '../api/types.ts'

export const taskLists = signal<TaskList[]>([])
/** Tasks assigned to me and filed in no list. */
export const inbox = signal<Task[]>([])
/** False until lists and inbox were fetched once. */
export const tasksLoaded = signal(false)
/** Incremented by every refresh, even a failed one: pages showing their own data refetch on change. */
export const tasksVersion = signal(0)

/** The inbox badge: unfiled tasks still to do. */
export const inboxToFile = computed(() => inbox.value.filter((t) => !t.completed).length)

/** The task dialogs (components/Tasks…): one open at a time, carrying what it acts on. `people`: pick a colleague. */
export type TaskDialog =
  | { kind: 'new-list' }
  | { kind: 'rename-list'; list: TaskList }
  | { kind: 'delete-list'; list: TaskList }
  | { kind: 'move'; task: Task }
  | { kind: 'assign'; task: Task; /** Add people, keeping the task where it is. */ also?: boolean }
  | { kind: 'people' }

export const taskDialog = signal<TaskDialog | null>(null)

/** People one task can be given to at once (the server's limit). */
export const MAX_ASSIGNEES = 10

/** Bumped by each fetch; a slower, older answer does not overwrite a newer one. */
let latest = 0

/** Lists and inbox, fetched together; rejects when either fails (callers decide what to say). */
export async function loadTasks(): Promise<void> {
  const attempt = ++latest
  const [lists, tasks] = await Promise.all([api.tasks.lists(), api.tasks.inbox()])
  if (attempt !== latest) return
  taskLists.value = lists
  inbox.value = tasks
  tasksLoaded.value = true
}

/** Like `loadTasks` after something changed (a live event, our own write): always tells the pages, never throws. */
export async function refreshTasks(): Promise<void> {
  try {
    await loadTasks()
  } catch {
    // Keep what is shown; the next refresh tries again.
  }
  tasksVersion.value += 1
}

export function resetTasks(): void {
  latest += 1
  taskLists.value = []
  inbox.value = []
  tasksLoaded.value = false
  tasksVersion.value = 0
  taskDialog.value = null
}
