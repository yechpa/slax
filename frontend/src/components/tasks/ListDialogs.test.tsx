import { afterEach, describe, expect, it } from 'vitest'
import type { TaskList } from '../../api/types.ts'
import type { Locale } from '../../i18n/index.ts'
import { taskDialog } from '../../store/tasks.ts'
import { resetUi } from '../../store/ui.ts'
import { deferred, type FakeHandler, type FakeReply } from '../../test/fakes.ts'
import { channel, taskList } from '../../test/fixtures.ts'
import { key, mountApp, plain, settle, typeInto, type Mounted } from '../../test/mountApp.tsx'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
  resetUi()
})

/** A server holding my lists; `extra` adds or overrides routes. */
function server(initial: TaskList[], extra: Record<string, FakeHandler> = {}) {
  const lists = [...initial]
  const routes: Record<string, FakeHandler> = {
    'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' })] }),
    'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
    'GET /api/v1/task-lists': () => ({ body: lists }),
    'GET /api/v1/tasks/inbox': () => ({ body: [] }),
    'GET /api/v1/task-lists/1/tasks': () => ({ body: [] }),
    'GET /api/v1/task-lists/9/tasks': () => ({ body: [] }),
    'POST /api/v1/task-lists': ({ body }) => {
      const created = taskList(9, { name: (body as { name: string }).name, position: 9 })
      lists.push(created)
      return { status: 201, body: created }
    },
    'PATCH /api/v1/task-lists/1': ({ body }) => {
      lists[0] = { ...lists[0], name: (body as { name: string }).name }
      return { body: lists[0] }
    },
    'DELETE /api/v1/task-lists/1': () => {
      lists.shift()
      return { status: 204 }
    },
    ...extra,
  }
  return { routes }
}

async function open(routes: Record<string, FakeHandler>, path = '/tasks/inbox', locale: Locale = 'en') {
  app = await mountApp(routes, path, { locale })
  await settle()
  return app
}

const sidebarAction = (label: string) =>
  [...app!.host.querySelectorAll<HTMLButtonElement>('button.nav-item--action')].find((b) => b.textContent?.includes(label))!
const headerButton = (label: string) => [...app!.host.querySelectorAll<HTMLButtonElement>('.tasks-header__actions button')].find((b) => b.title === label)!
const dialog = () => document.querySelector<HTMLDialogElement>('dialog')
const button = (label: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => plain(b.textContent) === label)!
const submit = async () => {
  dialog()!.querySelector('form')!.requestSubmit()
  await settle()
}
const title = () => plain(app!.host.querySelector('#channel-title')?.textContent)

describe('list dialogs', () => {
  it('new list dialog creates a list and opens it', async () => {
    const { routes } = server([taskList(1, { name: 'Home' })])
    await open(routes)
    const trigger = sidebarAction('New list')
    trigger.focus()
    trigger.click()
    await settle()
    expect(plain(dialog()!.querySelector('.dialog__title')?.textContent)).toBe('New list')
    const field = dialog()!.querySelector<HTMLInputElement>('input')!
    expect(document.activeElement).toBe(field)

    typeInto(field, '  Errands ')
    await settle()
    await submit()

    expect(app!.server.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/task-lists').map((c) => c.body)).toEqual([{ name: 'Errands' }])
    expect(dialog()).toBeNull()
    expect(taskDialog.value).toBeNull()
    expect(location.pathname).toBe('/tasks/l/9')
    // The sidebar lists it and the page is named after it.
    expect(title()).toBe('Errands')
    expect([...app!.host.querySelectorAll('.sidebar a.nav-item .nav-item__label')].map((n) => plain(n.textContent))).toContain('Errands')
    // Focus is back where the dialog was opened from.
    expect(document.activeElement).toBe(trigger)
  })

  it('an empty name sends nothing and keeps the dialog', async () => {
    const { routes } = server([])
    await open(routes)
    sidebarAction('New list').click()
    await settle()
    typeInto(dialog()!.querySelector('input')!, '   ')
    await settle()
    await submit()
    expect(app!.server.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/task-lists')).toBe(false)
    expect(dialog()).not.toBeNull()
    expect(plain(dialog()!.querySelector('.field__error')?.textContent)).toBe('A name is needed, 60 characters at most.')
  })

  it('a second submit while the first is in flight sends nothing more', async () => {
    const answer = deferred<FakeReply>()
    const { routes } = server([], { 'POST /api/v1/task-lists': () => answer.promise })
    await open(routes)
    sidebarAction('New list').click()
    await settle()
    typeInto(dialog()!.querySelector('input')!, 'Errands')
    await settle()
    await submit()
    await submit()
    expect(app!.server.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/task-lists')).toHaveLength(1)
    expect(button('Create list').disabled).toBe(true)
    answer.resolve({ status: 201, body: taskList(9, { name: 'Errands' }) })
    await settle()
    expect(dialog()).toBeNull()
  })

  it('the 50-list limit is said in the reader language and the typed name stays', async () => {
    const { routes } = server([], { 'POST /api/v1/task-lists': () => ({ status: 422, body: { error: 'task_list_limit' } }) })
    await open(routes, '/tasks/inbox', 'fr')
    sidebarAction('Nouvelle liste').click()
    await settle()
    const field = dialog()!.querySelector<HTMLInputElement>('input')!
    typeInto(field, 'Courses')
    await settle()
    await submit()
    expect(plain(dialog()!.querySelector('.field__error')?.textContent)).toBe('Vous avez déjà 50 listes, le maximum. Supprimez-en une d’abord.')
    expect(field.value).toBe('Courses')
    expect(taskDialog.value).toEqual({ kind: 'new-list' })
    // Not busy any more: the person can try again.
    expect(button('Créer la liste').disabled).toBe(false)
  })

  it('Cancel, Escape and the close button each clear the dialog state', async () => {
    const { routes } = server([])
    await open(routes)
    for (const close of [() => button('Cancel').click(), () => key(dialog()!, { key: 'Escape' }), () => dialog()!.querySelector<HTMLButtonElement>('.dialog__close')!.click()]) {
      sidebarAction('New list').click()
      await settle()
      expect(taskDialog.value).toEqual({ kind: 'new-list' })
      close()
      await settle()
      expect(taskDialog.value).toBeNull()
      expect(dialog()).toBeNull()
    }
  })

  it('rename list dialog starts from the current name and sends PATCH', async () => {
    const { routes } = server([taskList(1, { name: 'Home' })])
    await open(routes, '/tasks/l/1')
    expect(title()).toBe('Home')
    const trigger = headerButton('Rename list')
    trigger.focus()
    trigger.click()
    await settle()
    const field = dialog()!.querySelector<HTMLInputElement>('input')!
    expect(field.value).toBe('Home')
    typeInto(field, 'House')
    await settle()
    await submit()
    expect(app!.server.calls.find((c) => c.method === 'PATCH' && c.path === '/api/v1/task-lists/1')?.body).toEqual({ name: 'House' })
    expect(dialog()).toBeNull()
    expect(taskDialog.value).toBeNull()
    expect(title()).toBe('House')
    expect(location.pathname).toBe('/tasks/l/1')
    expect(document.activeElement).toBe(headerButton('Rename list'))
  })

  it('delete list dialog explains and sends DELETE', async () => {
    const { routes } = server([taskList(1, { name: 'Home' }), taskList(2, { name: 'Work' })])
    await open(routes, '/tasks/l/1')
    headerButton('Delete list').click()
    await settle()
    expect(dialog()!.getAttribute('role')).toBe('alertdialog')
    const text = plain(dialog()!.textContent)
    // Which tasks go, which come back (spec §6).
    expect(text).toContain('The tasks you wrote in “Home” are deleted with it.')
    expect(text).toContain('Tasks other people gave you go back to your “Assigned to me”.')
    expect(app!.server.calls.some((c) => c.method === 'DELETE')).toBe(false)

    button('Delete list').click()
    await settle()
    expect(app!.server.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/v1/task-lists/1'])
    expect(dialog()).toBeNull()
    expect(taskDialog.value).toBeNull()
    // The list that was open is gone: the inbox opens.
    expect(location.pathname).toBe('/tasks/inbox')
    expect([...app!.host.querySelectorAll('.sidebar a.nav-item .nav-item__label')].map((n) => plain(n.textContent))).not.toContain('Home')
    // Its trigger is gone too: focus lands on the page, not nowhere.
    expect(document.activeElement).toBe(app!.host.querySelector('#messages'))
  })

  it('a rename of a list that is gone says the list no longer exists', async () => {
    const { routes } = server([taskList(1, { name: 'Home' })], { 'PATCH /api/v1/task-lists/1': () => ({ status: 404, body: { message: 'Not Found' } }) })
    await open(routes, '/tasks/l/1')
    headerButton('Rename list').click()
    await settle()
    typeInto(dialog()!.querySelector('input')!, 'House')
    await settle()
    await submit()
    expect(plain(dialog()!.querySelector('.field__error')?.textContent)).toBe('This list no longer exists.')
    expect(taskDialog.value?.kind).toBe('rename-list')
  })

  it.each(['en', 'he', 'fr'] as const)('the list header buttons are named by their visible text (%s)', async (locale) => {
    const { routes } = server([taskList(1, { name: 'Home' })])
    await open(routes, '/tasks/l/1', locale)
    const buttons = [...app!.host.querySelectorAll<HTMLButtonElement>('.tasks-header__actions button')]
    expect(buttons).toHaveLength(2)
    for (const b of buttons) {
      const visible = plain(b.textContent).trim()
      expect(visible).not.toBe('')
      // WCAG 2.5.3: the accessible name (aria-label wins over the content) contains the visible text.
      const name = plain(b.getAttribute('aria-label') ?? b.textContent)
      expect(name).toContain(visible)
    }
  })

  it('a failed delete says so, keeps the dialog and the list', async () => {
    const { routes } = server([taskList(1, { name: 'Home' })], { 'DELETE /api/v1/task-lists/1': () => ({ status: 404, body: { message: 'Not Found' } }) })
    await open(routes, '/tasks/l/1')
    headerButton('Delete list').click()
    await settle()
    button('Delete list').click()
    await settle()
    expect(plain(dialog()!.querySelector('[role="alert"]')?.textContent)).toBe('This list no longer exists.')
    expect(location.pathname).toBe('/tasks/l/1')
    expect(button('Delete list').disabled).toBe(false)
  })
})
