import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientState } from '../../api/client.ts'
import type { Task } from '../../api/types.ts'
import { setLocale } from '../../i18n/index.ts'
import { session } from '../../store/session.ts'
import { resetTasks, taskDialog } from '../../store/tasks.ts'
import { resetUi, toasts } from '../../store/ui.ts'
import { deferred, fakeFetch, type FakeReply } from '../../test/fakes.ts'
import { DANA, ME, task } from '../../test/fixtures.ts'
import { settle, typeInto } from '../../test/mountApp.tsx'
import { TaskListView } from './TaskListView.tsx'
import { TaskRow } from './TaskRow.tsx'

let host: HTMLElement

beforeEach(() => {
  setLocale('en')
  resetClientState()
  resetTasks()
  session.value = { status: 'signed-in', me: ME }
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  render(null, host)
  host.remove()
  vi.unstubAllGlobals()
  resetTasks()
  resetUi()
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
})

const plain = (text: string | null | undefined) => (text ?? '').replace(/[⁨⁩]/g, '')
const box = (title: string) => host.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${title}"]`)!

function row(t: Task, handlers: { onChange?: (t: Task) => void; onRemove?: (id: number) => void } = {}) {
  render(<TaskRow task={t} onChange={handlers.onChange ?? (() => undefined)} onRemove={handlers.onRemove ?? (() => undefined)} />, host)
}

async function menu(): Promise<string[]> {
  host.querySelector<HTMLButtonElement>('.task-row__more')!.click()
  await settle(2)
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => plain(item.textContent))
}

const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((i) => plain(i.textContent) === label)!

describe('task row', () => {
  it('ticking a task is optimistic and rolls back on failure', async () => {
    const answer = deferred<FakeReply>()
    const server = fakeFetch({
      'GET /api/v1/tasks/inbox': () => ({ body: [task(5, { title: 'pay the rent', creator: DANA, list_id: null })] }),
      'GET /api/v1/task-lists': () => ({ body: [] }),
      'PUT /api/v1/tasks/5/completion': () => answer.promise,
    })
    vi.stubGlobal('fetch', server.fetch)
    render(<TaskListView view={{ kind: 'inbox' }} />, host)
    await settle()
    expect(box('pay the rent').checked).toBe(false)

    box('pay the rent').click()
    await settle(2)
    // Shown done at once, before the server answers.
    expect(box('pay the rent').checked).toBe(true)
    expect(box('pay the rent').closest('.tasks__done')).not.toBeNull()
    expect(server.calls.find((c) => c.method === 'PUT')?.body).toEqual({ completed: true })

    answer.resolve({ status: 500, body: {} })
    await settle()
    expect(box('pay the rent').checked).toBe(false)
    expect(box('pay the rent').closest('.tasks__open')).not.toBeNull()
    expect(toasts.value.map((t) => [t.tone, t.text])).toEqual([['error', 'The task could not be updated. Try again.']])
  })

  it('focus stays in the list when ticking: the next row, the previous one, then "Done"', async () => {
    const server = fakeFetch({
      'GET /api/v1/tasks/inbox': () => ({ body: [1, 2, 3].map((id) => task(id, { title: `t${id}`, creator: DANA, list_id: null })) }),
      'GET /api/v1/task-lists': () => ({ body: [] }),
      // Never answered: the optimistic rows stay as they are, and no refetch interferes.
      'PUT /api/v1/tasks/1/completion': () => new Promise(() => undefined),
      'PUT /api/v1/tasks/2/completion': () => new Promise(() => undefined),
      'PUT /api/v1/tasks/3/completion': () => new Promise(() => undefined),
    })
    vi.stubGlobal('fetch', server.fetch)
    render(<TaskListView view={{ kind: 'inbox' }} />, host)
    await settle()

    // The first of several: the next one.
    box('t1').focus()
    box('t1').click()
    await settle(2)
    expect(document.activeElement).toBe(box('t2'))
    // The last of the open ones: the one before it.
    box('t3').click()
    await settle(2)
    expect(document.activeElement).toBe(box('t2'))
    // No open task left: the "Done" title.
    box('t2').click()
    await settle(2)
    expect(document.activeElement).toBe(host.querySelector('.tasks__done-title'))
  })

  it('unticking the last done task keeps focus on it', async () => {
    const done = { completed: true, completed_at: '2026-11-08T09:00:00.000Z' }
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'GET /api/v1/tasks/inbox': () => ({ body: [task(1, { title: 'open', list_id: null }), task(2, { title: 'finished', list_id: null, ...done })] }),
        'GET /api/v1/task-lists': () => ({ body: [] }),
        'PUT /api/v1/tasks/2/completion': () => new Promise(() => undefined),
      }).fetch,
    )
    render(<TaskListView view={{ kind: 'inbox' }} />, host)
    await settle()
    box('finished').click()
    await settle(2)
    expect(box('finished').checked).toBe(false)
    expect(document.activeElement).toBe(box('finished'))
  })

  it('a Hebrew title renders with dir=auto', () => {
    row(task(1, { title: 'לקנות חלב' }))
    const title = host.querySelector('.task-row__title')!
    expect(title.getAttribute('dir')).toBe('auto')
    expect(title.textContent).toBe('לקנות חלב')
    expect(box('לקנות חלב')).not.toBeNull()
    expect(host.querySelector('.task-row__more')?.getAttribute('aria-label')).toBe('Actions for “⁨לקנות חלב⁩”')
  })

  it('the menu offers only what the viewer may do', async () => {
    // Mine, for me: everything but giving it back.
    const mine = task(1)
    row(mine)
    expect(await menu()).toEqual(['Rename', 'Make public', 'Assign to…', 'Move to…', 'Delete'])
    menuItem('Move to…').click()
    expect(taskDialog.value).toEqual({ kind: 'move', task: mine })
    render(null, host)

    // Created by me for dana: mine to edit, hers to file. No chip of mine; hers shows.
    const given = task(2, { assignee: DANA, list_id: null, visibility: 'public' })
    row(given)
    expect(plain(host.querySelector('.task-row__person')?.textContent)).toBe('for dana')
    expect(await menu()).toEqual(['Rename', 'Make private', 'Assign to…', 'Delete'])
    menuItem('Assign to…').click()
    expect(taskDialog.value).toEqual({ kind: 'assign', task: given })
    render(null, host)

    // Given to me by dana: I file it or give it back, nothing else.
    row(task(3, { creator: DANA, list_id: null }))
    expect(plain(host.querySelector('.task-row__person')?.textContent)).toBe('from dana')
    expect(await menu()).toEqual(['Move to…', 'Return to dana'])
  })

  it('rename, visibility, return and delete call the server', async () => {
    const server = fakeFetch({
      'PATCH /api/v1/tasks/1': ({ body }) => ({ body: task(1, body as Partial<Task>) }),
      'DELETE /api/v1/tasks/1': () => ({ status: 204 }),
      'POST /api/v1/tasks/3/return': () => ({ body: task(3, { creator: DANA, assignee: DANA }) }),
      'GET /api/v1/task-lists': () => ({ body: [] }),
      'GET /api/v1/tasks/inbox': () => ({ body: [] }),
    })
    vi.stubGlobal('fetch', server.fetch)
    const changed: Task[] = []
    const removed: number[] = []
    const handlers = { onChange: (t: Task) => changed.push(t), onRemove: (id: number) => removed.push(id) }

    row(task(1), handlers)
    await menu()
    menuItem('Rename').click()
    await settle(2)
    const field = host.querySelector<HTMLInputElement>('.task-row__edit input')!
    expect(document.activeElement).toBe(field)
    typeInto(field, 'new title')
    await settle(2)
    host.querySelector<HTMLFormElement>('.task-row__edit')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    await settle()
    await menu()
    menuItem('Make public').click()
    await settle()
    expect(server.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ title: 'new title' }, { visibility: 'public' }])
    expect(changed.map((t) => t.title)).toEqual(['new title', 'task 1'])

    // Delete asks first, in the row.
    await menu()
    menuItem('Delete').click()
    await settle(2)
    expect(server.calls.some((c) => c.method === 'DELETE')).toBe(false)
    const confirm = [...host.querySelectorAll<HTMLButtonElement>('.task-row__confirm button')].find((b) => b.textContent === 'Delete')!
    confirm.click()
    await settle()
    expect(removed).toEqual([1])
    render(null, host)

    row(task(3, { creator: DANA, list_id: null }), handlers)
    await menu()
    menuItem('Return to dana').click()
    await settle()
    expect(server.calls.some((c) => c.path === '/api/v1/tasks/3/return')).toBe(true)
    expect(removed).toEqual([1, 3])
  })
})
