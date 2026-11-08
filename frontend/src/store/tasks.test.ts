import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientState } from '../api/client.ts'
import type { Task, TaskList } from '../api/types.ts'
import { ME, DANA } from '../test/fixtures.ts'
import { fakeFetch } from '../test/fakes.ts'
import { inbox, inboxToFile, loadTasks, refreshTasks, resetTasks, taskDialog, taskLists, tasksLoaded, tasksVersion } from './tasks.ts'

const person = (u: { id: number; name: string; avatar_url: string | null }) => ({ id: u.id, name: u.name, avatar_url: u.avatar_url })

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `task ${id}`,
    visibility: 'private',
    completed: false,
    completed_at: null,
    list_id: null,
    creator: person(DANA),
    assignee: person(ME),
    created_at: '2026-11-08T08:00:00.000Z',
    ...overrides,
  }
}

const LISTS: TaskList[] = [
  { id: 1, name: 'Home', position: 0, open_count: 2 },
  { id: 2, name: 'Work', position: 1, open_count: 0 },
]

beforeEach(() => {
  resetClientState()
  resetTasks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
})

describe('task store', () => {
  it('loadTasks fills lists and inbox and inboxToFile ignores completed tasks', async () => {
    const server = fakeFetch({
      'GET /api/v1/task-lists': () => ({ body: LISTS }),
      'GET /api/v1/tasks/inbox': () => ({ body: [task(1), task(2, { completed: true, completed_at: '2026-11-08T09:00:00.000Z' }), task(3)] }),
    })
    vi.stubGlobal('fetch', server.fetch)
    expect(tasksLoaded.value).toBe(false)
    expect(inboxToFile.value).toBe(0)

    await loadTasks()

    expect(taskLists.value).toEqual(LISTS)
    expect(inbox.value.map((t) => t.id)).toEqual([1, 2, 3])
    expect(inboxToFile.value).toBe(2)
    expect(tasksLoaded.value).toBe(true)
  })

  it('refreshTasks bumps tasksVersion and keeps the old data when the request fails', async () => {
    let failing = false
    const server = fakeFetch({
      'GET /api/v1/task-lists': () => (failing ? { status: 500, body: { message: 'boom' } } : { body: LISTS }),
      'GET /api/v1/tasks/inbox': () => (failing ? 'network-error' : { body: [task(1)] }),
    })
    vi.stubGlobal('fetch', server.fetch)
    await loadTasks()
    const before = tasksVersion.value

    await refreshTasks()
    expect(tasksVersion.value).toBe(before + 1)

    failing = true
    await expect(refreshTasks()).resolves.toBeUndefined()
    expect(tasksVersion.value).toBe(before + 2)
    expect(taskLists.value).toEqual(LISTS)
    expect(inbox.value.map((t) => t.id)).toEqual([1])
    expect(tasksLoaded.value).toBe(true)
  })

  it('resetTasks empties everything', async () => {
    const server = fakeFetch({
      'GET /api/v1/task-lists': () => ({ body: LISTS }),
      'GET /api/v1/tasks/inbox': () => ({ body: [task(1)] }),
    })
    vi.stubGlobal('fetch', server.fetch)
    await loadTasks()
    await refreshTasks()
    taskDialog.value = { kind: 'rename-list', list: LISTS[0] }

    resetTasks()

    expect(taskLists.value).toEqual([])
    expect(inbox.value).toEqual([])
    expect(inboxToFile.value).toBe(0)
    expect(tasksLoaded.value).toBe(false)
    expect(tasksVersion.value).toBe(0)
    expect(taskDialog.value).toBeNull()
  })
})
