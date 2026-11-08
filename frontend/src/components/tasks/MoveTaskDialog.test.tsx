import { afterEach, describe, expect, it } from 'vitest'
import type { Task } from '../../api/types.ts'
import { taskDialog } from '../../store/tasks.ts'
import { resetUi } from '../../store/ui.ts'
import { deferred, type FakeHandler, type FakeReply } from '../../test/fakes.ts'
import { DANA, channel, task, taskList } from '../../test/fixtures.ts'
import { key, mountApp, plain, settle, type Mounted } from '../../test/mountApp.tsx'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
  resetUi()
})

/** Task 5 sits in my inbox (given by dana); moving it files it into a list. */
function server(extra: Record<string, FakeHandler> = {}) {
  let inbox: Task[] = [task(5, { title: 'call the bank', creator: DANA, list_id: null }), task(6, { title: 'stay put', creator: DANA, list_id: null })]
  const routes: Record<string, FakeHandler> = {
    'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' })] }),
    'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
    'GET /api/v1/task-lists': () => ({ body: [taskList(1, { name: 'Home' }), taskList(2, { name: 'Work' })] }),
    'GET /api/v1/tasks/inbox': () => ({ body: inbox }),
    'POST /api/v1/tasks/5/move': ({ body }) => {
      const moved = inbox.find((t) => t.id === 5)!
      inbox = inbox.filter((t) => t.id !== 5)
      return { body: { ...moved, list_id: (body as { list_id: number | null }).list_id } }
    },
    ...extra,
  }
  return { routes }
}

const titles = () => [...app!.host.querySelectorAll('.tasks__open .task-row__title')].map((t) => plain(t.textContent))
const dialog = () => document.querySelector<HTMLDialogElement>('dialog')
const choices = () => [...dialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
const choice = (label: string) => choices().find((c) => plain(c.closest('label')?.textContent) === label)!
const button = (label: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => plain(b.textContent) === label)!

async function openMove(title: string) {
  const row = [...app!.host.querySelectorAll<HTMLElement>('.task-row')].find((r) => plain(r.querySelector('.task-row__title')?.textContent) === title)!
  const more = row.querySelector<HTMLButtonElement>('.task-row__more')!
  more.focus()
  more.click()
  await settle(2)
  ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((i) => plain(i.textContent) === 'Move to…')!.click()
  await settle()
  return more
}

describe('move task dialog', () => {
  it('moving an inbox task into a list removes it from the inbox view', async () => {
    const { routes } = server()
    app = await mountApp(routes, '/tasks/inbox')
    await settle()
    expect(titles()).toEqual(['call the bank', 'stay put'])
    expect(plain(app.host.querySelector('.nav-item__badge')?.textContent)).toBe('2')

    await openMove('call the bank')
    // My lists, and the inbox ("unfiled") as a choice; the task's present place is chosen.
    expect(choices().map((c) => plain(c.closest('label')?.textContent))).toEqual(['Assigned to me (no list)', 'Home', 'Work'])
    expect(choice('Assigned to me (no list)').checked).toBe(true)
    // Nothing to do while the choice is unchanged.
    expect(button('Move').disabled).toBe(true)

    choice('Work').click()
    await settle()
    expect(button('Move').disabled).toBe(false)
    button('Move').click()
    await settle()

    expect(app.server.calls.filter((c) => c.path === '/api/v1/tasks/5/move').map((c) => [c.method, c.body])).toEqual([['POST', { list_id: 2 }]])
    expect(dialog()).toBeNull()
    expect(taskDialog.value).toBeNull()
    expect(titles()).toEqual(['stay put'])
    expect(plain(app.host.querySelector('.nav-item__badge')?.textContent)).toBe('1')
    // The row it came from is gone: focus lands on the page rather than nowhere.
    expect(document.activeElement).toBe(app.host.querySelector('#messages'))
  })

  it('"Assigned to me" sends list_id null', async () => {
    const { routes } = server({
      'GET /api/v1/tasks/inbox': () => ({ body: [] }),
      'GET /api/v1/task-lists/1/tasks': () => ({ body: [task(5, { title: 'filed', list_id: 1 })] }),
      'POST /api/v1/tasks/5/move': () => ({ body: task(5, { list_id: null }) }),
    })
    app = await mountApp(routes, '/tasks/l/1')
    await settle()
    await openMove('filed')
    expect(choice('Home').checked).toBe(true)
    choice('Assigned to me (no list)').click()
    await settle()
    button('Move').click()
    await settle()
    expect(app.server.calls.find((c) => c.path === '/api/v1/tasks/5/move')?.body).toEqual({ list_id: null })
  })

  it('a full list is refused in words, the dialog stays, and a second click sends once', async () => {
    const answer = deferred<FakeReply>()
    const { routes } = server({ 'POST /api/v1/tasks/5/move': () => answer.promise })
    app = await mountApp(routes, '/tasks/inbox', { locale: 'fr' })
    await settle()
    const row = app.host.querySelector<HTMLElement>('[data-task-id="5"]')!
    row.querySelector<HTMLButtonElement>('.task-row__more')!.click()
    await settle(2)
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((i) => plain(i.textContent) === 'Déplacer vers…')!.click()
    await settle()
    const work = choices().find((c) => plain(c.closest('label')?.textContent) === 'Work')!
    work.click()
    await settle()
    const submit = button('Déplacer')
    submit.click()
    await settle()
    submit.click()
    await settle()
    expect(app.server.calls.filter((c) => c.path === '/api/v1/tasks/5/move')).toHaveLength(1)
    expect(submit.disabled).toBe(true)

    answer.resolve({ status: 422, body: { error: 'task_limit' } })
    await settle()
    expect(plain(dialog()!.querySelector('[role="alert"]')?.textContent)).toBe('Cette liste est pleine (500 tâches). Supprimez-en ou déplacez-en d’abord.')
    expect(taskDialog.value).not.toBeNull()
    expect(submit.disabled).toBe(false)
    expect(app.host.querySelector('[data-task-id="5"]')).not.toBeNull()
  })

  it('Cancel and Escape clear the state and focus returns to the row menu button', async () => {
    const { routes } = server()
    app = await mountApp(routes, '/tasks/inbox')
    await settle()
    for (const close of [() => button('Cancel').click(), () => key(dialog()!, { key: 'Escape' })]) {
      const more = await openMove('stay put')
      expect(taskDialog.value?.kind).toBe('move')
      close()
      await settle()
      expect(taskDialog.value).toBeNull()
      expect(dialog()).toBeNull()
      expect(document.activeElement).toBe(more)
    }
    expect(app.server.calls.some((c) => c.path.endsWith('/move'))).toBe(false)
  })
})
