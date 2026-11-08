import { describe, expect, it } from 'vitest'
import { parseRoute, tasksPath, type TasksView } from './router.ts'

describe('tasks routes', () => {
  it('parseRoute maps /tasks, /tasks/inbox, /tasks/by-me, /tasks/l/12, /tasks/u/7 and rejects /tasks/l/abc and /tasks/l/0', () => {
    expect(parseRoute('/tasks')).toEqual({ name: 'tasks', view: { kind: 'inbox' } })
    expect(parseRoute('/tasks/')).toEqual({ name: 'tasks', view: { kind: 'inbox' } })
    expect(parseRoute('/tasks/inbox')).toEqual({ name: 'tasks', view: { kind: 'inbox' } })
    expect(parseRoute('/tasks/by-me')).toEqual({ name: 'tasks', view: { kind: 'by-me' } })
    expect(parseRoute('/tasks/l/12')).toEqual({ name: 'tasks', view: { kind: 'list', id: 12 } })
    expect(parseRoute('/tasks/u/7')).toEqual({ name: 'tasks', view: { kind: 'user', id: 7 } })
    for (const path of ['/tasks/l/abc', '/tasks/l/0', '/tasks/u/0', '/tasks/l', '/tasks/x', '/tasks/l/12/extra', '/Tasks']) {
      expect(parseRoute(path).name).toBe('unknown')
    }
  })

  it('tasksPath round-trips parseRoute', () => {
    const views: TasksView[] = [{ kind: 'inbox' }, { kind: 'by-me' }, { kind: 'list', id: 12 }, { kind: 'user', id: 7 }]
    for (const view of views) expect(parseRoute(tasksPath(view))).toEqual({ name: 'tasks', view })
    expect(tasksPath({ kind: 'inbox' })).toBe('/tasks/inbox')
  })
})
