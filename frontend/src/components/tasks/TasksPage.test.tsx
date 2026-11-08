import { afterEach, describe, expect, it } from 'vitest'
import type { Task } from '../../api/types.ts'
import type { Locale } from '../../i18n/index.ts'
import { SEARCH_DELAY_MS } from '../../lib/search.ts'
import { resetUi } from '../../store/ui.ts'
import type { FakeHandler } from '../../test/fakes.ts'
import { DANA, NOAM, channel, task, taskList } from '../../test/fixtures.ts'
import { mountApp, plain, settle, typeInto, type Mounted } from '../../test/mountApp.tsx'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
  resetUi()
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A small server holding list 1's tasks: what is created shows up in the next fetch too. */
function server(initial: Task[] = [], extra: Record<string, FakeHandler> = {}) {
  const tasks = [...initial]
  const posted: unknown[] = []
  let nextId = 100
  const routes: Record<string, FakeHandler> = {
    'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' })] }),
    'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
    'GET /api/v1/task-lists': () => ({ body: [taskList(1, { name: 'Home' }), taskList(2, { name: 'Work' })] }),
    'GET /api/v1/tasks/inbox': () => ({ body: [] }),
    'GET /api/v1/task-lists/1/tasks': () => ({ body: tasks }),
    'GET /api/v1/users': ({ query }) => ({ body: [DANA, NOAM].filter((p) => p.name.includes(query.get('q') ?? '')) }),
    'POST /api/v1/tasks': ({ body }) => {
      posted.push(body)
      const sent = body as { title: string; visibility: Task['visibility']; list_id?: number; assignee_id?: number }
      const created = task(nextId++, {
        title: sent.title,
        visibility: sent.visibility,
        list_id: sent.assignee_id ? null : (sent.list_id ?? 1),
        assignee: sent.assignee_id === DANA.id ? DANA : task(0).assignee,
      })
      if (created.list_id === 1) tasks.push(created)
      return { status: 201, body: created }
    },
    ...extra,
  }
  return { routes, posted }
}

async function open(routes: Record<string, FakeHandler>, path = '/tasks/l/1', locale: Locale = 'en') {
  app = await mountApp(routes, path, { locale })
  await settle()
  return app
}

const form = () => app!.host.querySelector<HTMLFormElement>('form.new-task')!
const titleField = () => form().querySelector<HTMLInputElement>('input.input')!
const titles = (selector = '.tasks__open') => [...app!.host.querySelectorAll(`${selector} .task-row__title`)].map((t) => plain(t.textContent))
const submit = async () => {
  // The typed title reaches the form's state on the next render, as between two keystrokes.
  await settle(2)
  form().querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
  await settle()
}

describe('tasks page', () => {
  it('creating a task sends visibility private by default and shows it in the list', async () => {
    const { routes, posted } = server([task(1, { title: 'water the plants' })])
    await open(routes)
    // The page is a task page: the "open a default channel" effect left it alone.
    expect(location.pathname).toBe('/tasks/l/1')
    expect(plain(app!.host.querySelector('#channel-title')?.textContent)).toBe('Home')
    expect(app!.host.querySelector('.shell__main')?.getAttribute('aria-labelledby')).toBe('channel-title')
    expect(titles()).toEqual(['water the plants'])

    // Private is chosen from the start, and shown.
    const checked = form().querySelector<HTMLInputElement>('.segmented input:checked')!
    expect(checked.value).toBe('private')
    expect(plain(checked.closest('label')?.textContent)).toBe('Private')

    typeInto(titleField(), '  buy bread ')
    await submit()
    expect(posted).toEqual([{ title: 'buy bread', visibility: 'private', list_id: 1 }])
    expect(titles()).toEqual(['water the plants', 'buy bread'])
    expect(titleField().value).toBe('')
  })

  it('choosing public sends public', async () => {
    const { routes, posted } = server()
    await open(routes)
    const pub = form().querySelector<HTMLInputElement>('.segmented input[value="public"]')!
    pub.click()
    await settle()
    typeInto(titleField(), 'team lunch')
    await submit()
    expect(posted).toEqual([{ title: 'team lunch', visibility: 'public', list_id: 1 }])
    expect(app!.host.querySelector('.tasks__open .task-row__visibility')?.textContent).toBe('public')
  })

  it('choosing a colleague as assignee sends assignee_id and no list_id', async () => {
    const { routes, posted } = server()
    await open(routes)
    expect(form().querySelector('select')).not.toBeNull()

    const picker = form().querySelector<HTMLInputElement>('.people-picker__input')!
    typeInto(picker, 'da')
    await wait(SEARCH_DELAY_MS + 20)
    await settle()
    document.querySelector<HTMLElement>('.new-task [role="option"]')!.click()
    await settle()
    // The list choice goes; a hint says where the task will be.
    expect(form().querySelector('select')).toBeNull()
    expect(plain(form().querySelector('.new-task__inbox')?.textContent)).toBe("It goes to dana's “Assigned to me”.")

    typeInto(titleField(), 'review the slides')
    await submit()
    expect(posted).toEqual([{ title: 'review the slides', visibility: 'private', assignee_id: DANA.id }])
    // Not in my list: it went to dana.
    expect(titles()).toEqual([])
  })

  it('a server refusal (inbox_full) shows its translated message and keeps the typed title', async () => {
    const { routes } = server([], { 'POST /api/v1/tasks': () => ({ status: 422, body: { error: 'inbox_full' } }) })
    await open(routes, '/tasks/l/1', 'fr')
    typeInto(titleField(), 'relire le contrat')
    await submit()
    expect(plain(form().querySelector('[role="alert"]')?.textContent)).toBe(
      'La boîte « Assignées à moi » de cette personne est pleine (200 tâches à ranger). Elle doit d’abord en ranger.',
    )
    expect(titleField().value).toBe('relire le contrat')
  })

  it('completed tasks sit under "Done" and stay struck through', async () => {
    const done = { completed: true, completed_at: '2026-11-08T09:00:00.000Z' }
    const { routes } = server([task(1, { title: 'open one' }), task(2, { title: 'finished', ...done }), task(3, { title: 'also finished', ...done })])
    await open(routes)
    expect(titles()).toEqual(['open one'])
    const section = app!.host.querySelector<HTMLDetailsElement>('details.tasks__done')!
    expect(plain(section.querySelector('summary')?.textContent)).toBe('Done (2)')
    expect(titles('.tasks__done')).toEqual(['finished', 'also finished'])
    for (const row of section.querySelectorAll('.task-row')) {
      expect(row.classList.contains('task-row--done')).toBe(true)
      expect(row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
    }
  })

  it('a failed load says so with Retry; a missing list says not found', async () => {
    let fail = true
    const { routes } = server([task(1, { title: 'back again' })])
    const list = routes['GET /api/v1/task-lists/1/tasks']
    routes['GET /api/v1/task-lists/1/tasks'] = (request) => (fail ? { status: 500, body: {} } : list(request))
    await open(routes)
    expect(plain(app!.host.querySelector('.empty')?.textContent)).toContain('Tasks could not be loaded.')
    fail = false
    const retry = [...app!.host.querySelectorAll<HTMLButtonElement>('.empty button')].find((b) => b.textContent?.includes('Retry'))!
    retry.click()
    await settle()
    expect(titles()).toEqual(['back again'])

    app!.cleanup()
    app = null
    await open(server().routes, '/tasks/l/9')
    expect(plain(app!.host.querySelector('.empty')?.textContent)).toContain('This list does not exist, or is not yours.')
  })

  it('the inbox and by-me views list their tasks, and empty ones say so', async () => {
    const { routes } = server([], {
      'GET /api/v1/tasks/inbox': () => ({ body: [task(5, { title: 'call the bank', creator: DANA, list_id: null })] }),
      'GET /api/v1/tasks/by-me': () => ({ body: [] }),
    })
    await open(routes, '/tasks/inbox')
    expect(plain(app!.host.querySelector('#channel-title')?.textContent)).toBe('Assigned to me')
    expect(titles()).toEqual(['call the bank'])
    expect(plain(app!.host.querySelector('.task-row__person')?.textContent)).toBe('from dana')
    expect(app!.host.querySelector('form.new-task')).toBeNull()

    app!.cleanup()
    app = null
    await open(routes, '/tasks/by-me')
    expect(plain(app!.host.querySelector('#channel-title')?.textContent)).toBe('Assigned by me')
    expect(plain(app!.host.querySelector('.empty')?.textContent)).toContain('You have not given anyone a task.')
  })
})
