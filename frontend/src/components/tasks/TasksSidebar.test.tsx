import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../i18n/index.ts'
import { parseRoute, route } from '../../router.ts'
import { session } from '../../store/session.ts'
import { inbox, resetTasks, taskDialog, taskLists } from '../../store/tasks.ts'
import { DANA, ME, task, taskList } from '../../test/fixtures.ts'
import { flush } from '../../test/fakes.ts'
import { TasksSidebar } from './TasksSidebar.tsx'

let host: HTMLElement

beforeEach(() => {
  setLocale('en')
  session.value = { status: 'signed-in', me: ME }
  resetTasks()
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  render(null, host)
  host.remove()
  resetTasks()
  route.value = parseRoute('/')
})

const plain = (text: string | null | undefined) => (text ?? '').replace(/[⁨⁩]/g, '')
const rows = () => [...host.querySelectorAll<HTMLAnchorElement>('a.nav-item')]
const row = (label: string) => rows().find((a) => plain(a.querySelector('.nav-item__label')?.textContent) === label)
const action = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button.nav-item')].find((b) => b.textContent?.includes(label))!

describe('tasks sidebar', () => {
  it('the sidebar lists inbox, by-me and my lists, and the badge counts uncompleted inbox tasks only', async () => {
    route.value = parseRoute('/tasks/l/2')
    taskLists.value = [taskList(1, { name: 'Home', open_count: 3 }), taskList(2, { name: 'עבודה', open_count: 0 })]
    const fromDana = { creator: DANA, list_id: null }
    inbox.value = [task(10, fromDana), task(11, fromDana), task(12, { ...fromDana, completed: true, completed_at: '2026-11-08T09:00:00.000Z' })]
    render(<TasksSidebar />, host)
    await flush()

    expect(plain(host.querySelector('h2')?.textContent)).toBe('tasks')
    expect(rows().map((a) => [plain(a.querySelector('.nav-item__label')?.textContent), a.getAttribute('href')])).toEqual([
      ['Assigned to me', '/tasks/inbox'],
      ['Assigned by me', '/tasks/by-me'],
      ['Home', '/tasks/l/1'],
      ['עבודה', '/tasks/l/2'],
    ])
    // Two to file: the completed one does not count; the accessible name says what the number is.
    const badge = row('Assigned to me')!.querySelector('.nav-item__badge')!
    expect(badge.textContent).toBe('2')
    expect(badge.getAttribute('aria-label')).toBe('2 tasks to file')
    // A list's hint: its open tasks (none: no hint).
    expect(row('Home')!.querySelector('.nav-item__tag')?.getAttribute('aria-label')).toBe('3 open')
    expect(row('עבודה')!.querySelector('.nav-item__tag')).toBeNull()
    expect(row('עבודה')!.getAttribute('aria-current')).toBe('page')
    expect(row('Home')!.getAttribute('aria-current')).toBeNull()

    // Nothing to file: no badge.
    inbox.value = inbox.value.map((t) => ({ ...t, completed: true }))
    await flush()
    expect(row('Assigned to me')!.querySelector('.nav-item__badge')).toBeNull()
  })

  it('new list and people\'s tasks open their dialogs', async () => {
    render(<TasksSidebar />, host)
    await flush()
    action('New list').click()
    expect(taskDialog.value).toEqual({ kind: 'new-list' })
    taskDialog.value = null
    action("People's tasks").click()
    expect(taskDialog.value).toEqual({ kind: 'people' })
  })
})
