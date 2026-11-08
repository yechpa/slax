import { afterEach, describe, expect, it } from 'vitest'
import type { ColleagueTasks as ColleaguePage } from '../../api/types.ts'
import { SEARCH_DELAY_MS } from '../../lib/search.ts'
import { taskDialog, tasksVersion } from '../../store/tasks.ts'
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

/** What dana holds that I may see: a public task of hers, and a private one I wrote for her. */
const PAGE: ColleaguePage = {
  user: DANA,
  lists: [
    { id: 11, name: 'Garden', tasks: [task(20, { title: 'water the plants', creator: DANA, assignee: DANA, visibility: 'public', list_id: 11 })] },
    { id: 12, name: 'גינה', tasks: [task(21, { title: 'plant tulips', creator: DANA, assignee: DANA, visibility: 'public', list_id: 12, completed: true, completed_at: '2026-11-08T09:00:00.000Z' })] },
  ],
  unfiled: [task(22, { title: 'review my draft', creator: { id: 1, name: 'Alice', avatar_url: null }, assignee: DANA, list_id: null })],
}

function server(extra: Record<string, FakeHandler> = {}) {
  const routes: Record<string, FakeHandler> = {
    'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' })] }),
    'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
    'GET /api/v1/task-lists': () => ({ body: [taskList(1, { name: 'Home' })] }),
    'GET /api/v1/tasks/inbox': () => ({ body: [] }),
    'GET /api/v1/users': ({ query }) => ({ body: [DANA, NOAM].filter((p) => p.name.includes(query.get('q') ?? '')) }),
    'GET /api/v1/users/2/tasks': () => ({ body: PAGE }),
    ...extra,
  }
  return { routes }
}

const groups = () =>
  [...app!.host.querySelectorAll<HTMLElement>('.tasks__group')].map((g) => [
    plain(g.querySelector('.tasks__group-title')?.textContent),
    [...g.querySelectorAll('.task-row__title')].map((t) => plain(t.textContent)),
  ])
const rowOf = (title: string) => [...app!.host.querySelectorAll<HTMLElement>('.task-row')].find((r) => plain(r.querySelector('.task-row__title')?.textContent) === title)!
const dialog = () => document.querySelector<HTMLDialogElement>('dialog')

describe('colleague tasks', () => {
  it('picking a colleague opens their page, which shows lists with only visible tasks', async () => {
    const { routes } = server()
    app = await mountApp(routes, '/tasks/inbox')
    await settle()
    const trigger = [...app.host.querySelectorAll<HTMLButtonElement>('button.nav-item--action')].find((b) => b.textContent?.includes("People's tasks"))!
    trigger.focus()
    trigger.click()
    await settle()
    expect(plain(dialog()!.querySelector('.dialog__title')?.textContent)).toBe("People's tasks")
    const input = dialog()!.querySelector<HTMLInputElement>('.people-picker__input')!
    expect(document.activeElement).toBe(input)
    typeInto(input, 'da')
    await wait(SEARCH_DELAY_MS + 20)
    await settle()
    dialog()!.querySelector<HTMLElement>('[role="option"]')!.click()
    await settle()

    expect(location.pathname).toBe('/tasks/u/2')
    expect(dialog()).toBeNull()
    expect(taskDialog.value).toBeNull()
    expect(plain(app.host.querySelector('#channel-title')?.textContent)).toBe("dana's tasks")
    expect(plain(document.title)).toBe("dana's tasks · slax")
    // Exactly what the server let through, grouped by list, then the unfiled ones.
    expect(groups()).toEqual([
      ['Garden', ['water the plants']],
      ['גינה', ['plant tulips']],
      ['No list', ['review my draft']],
    ])
    // The page is dana's: no new-task form, and no list actions.
    expect(app.host.querySelector('form.new-task')).toBeNull()
    expect(app.host.querySelector('.tasks-header__actions')).toBeNull()
    // Hers to tick, not mine: the box is disabled and there is no menu.
    const hers = rowOf('water the plants')
    expect(hers.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true)
    expect(hers.querySelector('.task-row__more')).toBeNull()
    expect(rowOf('plant tulips').querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
    // I wrote this one: I may tick it and manage it.
    const mine = rowOf('review my draft')
    expect(mine.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(false)
    expect(mine.querySelector('.task-row__more')).not.toBeNull()
  })

  it('what the viewer may do works on the page: assigning my task elsewhere refetches the page', async () => {
    let page = PAGE
    const { routes } = server({
      'GET /api/v1/users/2/tasks': () => ({ body: page }),
      'PATCH /api/v1/tasks/22': ({ body }) => {
        page = { ...PAGE, unfiled: [] }
        return { body: { ...PAGE.unfiled[0], assignee: NOAM, ...(body as object) } }
      },
    })
    app = await mountApp(routes, '/tasks/u/2')
    await settle()
    const more = rowOf('review my draft').querySelector<HTMLButtonElement>('.task-row__more')!
    more.click()
    await settle(2)
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((i) => plain(i.textContent) === 'Assign to…')!.click()
    await settle()
    typeInto(dialog()!.querySelector<HTMLInputElement>('.people-picker__input')!, 'נע')
    await wait(SEARCH_DELAY_MS + 20)
    await settle()
    dialog()!.querySelector<HTMLElement>('[role="option"]')!.click()
    await settle()
    dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    await settle()
    expect(app.server.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ assignee_id: NOAM.id })
    expect(groups().map(([name]) => name)).toEqual(['Garden', 'גינה'])
  })

  it('a 404 on a colleague\'s page shows not found', async () => {
    const { routes } = server({ 'GET /api/v1/users/9/tasks': () => ({ status: 404, body: { message: 'Not Found' } }) })
    app = await mountApp(routes, '/tasks/u/9')
    await settle()
    expect(plain(app.host.querySelector('.empty')?.textContent)).toContain("This person's tasks are not available.")
    expect(app.host.querySelector('.tasks__group')).toBeNull()
    expect(plain(app.host.querySelector('#channel-title')?.textContent)).toBe('Tasks')
  })

  it('a person with nothing visible says so; a failed load says so with Retry', async () => {
    let state: 'fail' | 'empty' = 'fail'
    const { routes } = server({
      'GET /api/v1/users/2/tasks': () => (state === 'fail' ? { status: 500, body: {} } : { body: { user: DANA, lists: [], unfiled: [] } }),
    })
    app = await mountApp(routes, '/tasks/u/2')
    await settle()
    expect(plain(app.host.querySelector('.empty')?.textContent)).toContain('Tasks could not be loaded.')
    state = 'empty'
    const retry = [...app.host.querySelectorAll<HTMLButtonElement>('.empty button')].find((b) => b.textContent?.includes('Retry'))!
    retry.click()
    await settle()
    expect(plain(app.host.querySelector('.empty')?.textContent)).toContain('dana has no tasks you can see.')
    expect(plain(app.host.querySelector('#channel-title')?.textContent)).toBe("dana's tasks")
  })

  it('refetches when the tasks change (a live event), keeping what is shown if that fails', async () => {
    let page = PAGE
    let fail = false
    const { routes } = server({ 'GET /api/v1/users/2/tasks': () => (fail ? { status: 500, body: {} } : { body: page }) })
    app = await mountApp(routes, '/tasks/u/2')
    await settle()
    expect(groups().map(([name]) => name)).toEqual(['Garden', 'גינה', 'No list'])

    page = { ...PAGE, lists: [PAGE.lists[0]], unfiled: [] }
    tasksVersion.value += 1
    await settle()
    expect(groups()).toEqual([['Garden', ['water the plants']]])

    fail = true
    tasksVersion.value += 1
    await settle()
    expect(groups()).toEqual([['Garden', ['water the plants']]])
    expect(app.host.querySelector('.empty')).toBeNull()
  })

  it('the people dialog: Escape clears its state and sends nothing', async () => {
    const { routes } = server()
    app = await mountApp(routes, '/tasks/inbox')
    await settle()
    const trigger = [...app.host.querySelectorAll<HTMLButtonElement>('button.nav-item--action')].find((b) => b.textContent?.includes("People's tasks"))!
    trigger.focus()
    trigger.click()
    await settle()
    expect(taskDialog.value).toEqual({ kind: 'people' })
    key(dialog()!, { key: 'Escape' })
    await settle()
    expect(taskDialog.value).toBeNull()
    expect(dialog()).toBeNull()
    expect(location.pathname).toBe('/tasks/inbox')
    expect(document.activeElement).toBe(trigger)
  })
})
