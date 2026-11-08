import { afterEach, describe, expect, it } from 'vitest'
import type { Task } from '../../api/types.ts'
import { SEARCH_DELAY_MS } from '../../lib/search.ts'
import { taskDialog } from '../../store/tasks.ts'
import { resetUi } from '../../store/ui.ts'
import { type FakeHandler } from '../../test/fakes.ts'
import { DANA, NOAM, channel, task, taskList } from '../../test/fixtures.ts'
import { key, mountApp, plain, settle, typeInto, type Mounted } from '../../test/mountApp.tsx'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
  resetUi()
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** List 1 holds two tasks of mine; assigning one to dana takes it out of the list. */
function server(extra: Record<string, FakeHandler> = {}) {
  let tasks: Task[] = [task(1, { title: 'review the slides' }), task(2, { title: 'water the plants' })]
  const routes: Record<string, FakeHandler> = {
    'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' })] }),
    'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
    'GET /api/v1/task-lists': () => ({ body: [taskList(1, { name: 'Home' })] }),
    'GET /api/v1/tasks/inbox': () => ({ body: [] }),
    'GET /api/v1/task-lists/1/tasks': () => ({ body: tasks }),
    // The directory never returns a banned account: only these people exist for the picker.
    'GET /api/v1/users': ({ query }) => ({ body: [DANA, NOAM].filter((p) => p.name.includes(query.get('q') ?? '')) }),
    'PATCH /api/v1/tasks/1': ({ body }) => {
      const moved = tasks.find((t) => t.id === 1)!
      tasks = tasks.filter((t) => t.id !== 1)
      return { body: { ...moved, assignee: DANA, list_id: null, ...(body as object) } }
    },
    ...extra,
  }
  return { routes }
}

const titles = () => [...app!.host.querySelectorAll('.tasks__open .task-row__title')].map((t) => plain(t.textContent))
const dialog = () => document.querySelector<HTMLDialogElement>('dialog')
const button = (label: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => plain(b.textContent) === label)!

async function openAssign(title: string) {
  const row = [...app!.host.querySelectorAll<HTMLElement>('.task-row')].find((r) => plain(r.querySelector('.task-row__title')?.textContent) === title)!
  const more = row.querySelector<HTMLButtonElement>('.task-row__more')!
  more.focus()
  more.click()
  await settle(2)
  ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((i) => plain(i.textContent) === 'Assign to…')!.click()
  await settle()
  return more
}

async function search(text: string) {
  typeInto(dialog()!.querySelector<HTMLInputElement>('.people-picker__input')!, text)
  await wait(SEARCH_DELAY_MS + 20)
  await settle()
}

describe('assign dialog', () => {
  it('assigning sends assignee_id and the task leaves my list view', async () => {
    const { routes } = server()
    app = await mountApp(routes, '/tasks/l/1')
    await settle()
    expect(titles()).toEqual(['review the slides', 'water the plants'])

    await openAssign('review the slides')
    expect(plain(dialog()!.querySelector('.dialog__title')?.textContent)).toBe('Assign “review the slides”')
    // Nobody chosen yet: nothing to send.
    expect(button('Assign').disabled).toBe(true)

    await search('da')
    // What the directory answered is what is offered.
    const options = [...dialog()!.querySelectorAll('[role="option"] .people-picker__name')].map((o) => plain(o.textContent))
    expect(options).toEqual(['dana'])
    dialog()!.querySelector<HTMLElement>('[role="option"]')!.click()
    await settle()
    expect(button('Assign').disabled).toBe(false)
    button('Assign').click()
    await settle()

    expect(app.server.calls.filter((c) => c.method === 'PATCH').map((c) => [c.path, c.body])).toEqual([['/api/v1/tasks/1', { assignee_id: DANA.id }]])
    expect(dialog()).toBeNull()
    expect(taskDialog.value).toBeNull()
    expect(titles()).toEqual(['water the plants'])
    expect(document.activeElement).toBe(app.host.querySelector('#messages'))
  })

  it('"Also assign to…" takes several people, sends assignee_ids and leaves the task in my list', async () => {
    const { routes } = server({
      'POST /api/v1/tasks/1/assign': () => ({ status: 200, body: [task(11, { assignee: DANA, list_id: null }), task(12, { assignee: NOAM, list_id: null })] }),
    })
    app = await mountApp(routes, '/tasks/l/1')
    await settle()
    const row = app.host.querySelector<HTMLElement>('[data-task-id="1"]')!
    row.querySelector<HTMLButtonElement>('.task-row__more')!.click()
    await settle(2)
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((i) => plain(i.textContent) === 'Also assign to…')!.click()
    await settle()
    expect(plain(dialog()!.querySelector('.dialog__title')?.textContent)).toBe('Also assign “review the slides”')

    await search('da')
    dialog()!.querySelector<HTMLElement>('[role="option"]')!.click()
    await settle()
    // One person does not fill the field in this mode.
    await search('נע')
    dialog()!.querySelector<HTMLElement>('[role="option"]')!.click()
    await settle()
    expect(dialog()!.querySelectorAll('.person-chip').length).toBe(2)
    button('Assign').click()
    await settle()

    expect(app.server.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/assign')).map((c) => [c.path, c.body])).toEqual([
      ['/api/v1/tasks/1/assign', { assignee_ids: [DANA.id, NOAM.id] }],
    ])
    expect(dialog()).toBeNull()
    // Mine stays where it is.
    expect(titles()).toEqual(['review the slides', 'water the plants'])
  })

  it('"Also assign to…" says so when everyone already had the task', async () => {
    const { routes } = server({ 'POST /api/v1/tasks/1/assign': () => ({ status: 200, body: [] }) })
    app = await mountApp(routes, '/tasks/l/1')
    await settle()
    app.host.querySelector<HTMLElement>('[data-task-id="1"] .task-row__more')!.click()
    await settle(2)
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((i) => plain(i.textContent) === 'Also assign to…')!.click()
    await settle()
    await search('da')
    dialog()!.querySelector<HTMLElement>('[role="option"]')!.click()
    await settle()
    button('Assign').click()
    await settle()
    expect(dialog()).toBeNull()
    expect(plain(document.body.textContent)).toContain('Everyone you picked already has this task.')
  })

  it('a refusal (invalid_assignee) is said in Hebrew, keeps the dialog and the choice', async () => {
    const { routes } = server({ 'PATCH /api/v1/tasks/1': () => ({ status: 422, body: { error: 'invalid_assignee' } }) })
    app = await mountApp(routes, '/tasks/l/1', { locale: 'he' })
    await settle()
    const row = app.host.querySelector<HTMLElement>('[data-task-id="1"]')!
    row.querySelector<HTMLButtonElement>('.task-row__more')!.click()
    await settle(2)
    // Second item of the author's menu: rename, visibility, assign…
    document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[2].click()
    await settle()
    await search('נע')
    dialog()!.querySelector<HTMLElement>('[role="option"]')!.click()
    await settle()
    const submit = dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!
    submit.click()
    await settle()
    expect(plain(dialog()!.querySelector('[role="alert"]')?.textContent)).toBe('אי אפשר להקצות משימות לאדם הזה.')
    expect(dialog()!.querySelector('.person-chip')).not.toBeNull()
    expect(submit.disabled).toBe(false)
    expect(titles().length).toBe(2)
  })

  it('too many actions (429) says to wait, in French, and keeps the dialog', async () => {
    const { routes } = server({ 'PATCH /api/v1/tasks/1': () => ({ status: 429, body: { message: 'Too Many Attempts.' } }) })
    app = await mountApp(routes, '/tasks/l/1', { locale: 'fr' })
    await settle()
    const row = app.host.querySelector<HTMLElement>('[data-task-id="1"]')!
    row.querySelector<HTMLButtonElement>('.task-row__more')!.click()
    await settle(2)
    document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[2].click()
    await settle()
    await search('da')
    dialog()!.querySelector<HTMLElement>('[role="option"]')!.click()
    await settle()
    const submit = dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!
    submit.click()
    await settle()
    expect(plain(dialog()!.querySelector('[role="alert"]')?.textContent)).toBe('Trop d’actions d’affilée. Attendez un instant, puis réessayez.')
    expect(submit.disabled).toBe(false)
  })

  it('Cancel and Escape clear the state and send nothing; focus returns to the row menu button', async () => {
    const { routes } = server()
    app = await mountApp(routes, '/tasks/l/1')
    await settle()
    for (const close of [() => button('Cancel').click(), () => key(dialog()!, { key: 'Escape' })]) {
      const more = await openAssign('water the plants')
      expect(taskDialog.value?.kind).toBe('assign')
      close()
      await settle()
      expect(taskDialog.value).toBeNull()
      expect(dialog()).toBeNull()
      expect(document.activeElement).toBe(more)
    }
    expect(app.server.calls.some((c) => c.method === 'PATCH')).toBe(false)
  })
})
