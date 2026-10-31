import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientState } from '../api/client.ts'
import { api } from '../api/endpoints.ts'
import { setLocale } from '../i18n/index.ts'
import { createChat } from '../store/chat.ts'
import { resetChannels } from '../store/channels.ts'
import { resetTimelines } from '../store/messages.ts'
import { session } from '../store/session.ts'
import { ME, NOAM, DANA, channel, live } from '../test/fixtures.ts'
import { fakeFetch } from '../test/fakes.ts'
import { Sidebar } from './Sidebar.tsx'

let host: HTMLElement

beforeEach(() => {
  setLocale('en')
  resetClientState()
  session.value = { status: 'signed-in', me: ME }
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  render(null, host)
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetChannels()
  resetTimelines()
})

const badge = (name: string) =>
  [...host.querySelectorAll('.nav-item')].find((item) => item.querySelector('.nav-item__label')?.textContent === name)?.querySelector('.nav-item__badge')

describe('sidebar', () => {
  it('unread_badge_caps_at_99_and_clears_on_read', async () => {
    vi.useFakeTimers()
    const server = fakeFetch({
      'GET /api/v1/channels': () => ({
        body: [channel(7, { name: 'general', unread_count: 150, last_read_message_id: 10 }), channel(8, { name: 'random', unread_count: 99 })],
      }),
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(10), live(11)], has_more: false } }),
      'POST /api/v1/channels/7/read': () => ({ status: 204 }),
    })
    vi.stubGlobal('fetch', server.fetch)
    const chat = createChat({ api, realtime: null })
    await chat.start()
    render(<Sidebar currentId={null} />, host)

    // The badge stops at 99+; its accessible name keeps the true count.
    expect(badge('general')?.textContent).toBe('99+')
    expect(badge('general')?.getAttribute('aria-label')).toBe('150 unread messages')
    expect(badge('general')?.querySelector('bdi')?.getAttribute('dir')).toBe('ltr')
    expect(badge('random')?.textContent).toBe('99')

    // Read: the channel is open at the bottom for a quiet second.
    chat.openChannel(7)
    await vi.advanceTimersByTimeAsync(0)
    chat.noteReadable(7)
    await vi.advanceTimersByTimeAsync(1000)
    expect(server.calls.filter((c) => c.path === '/api/v1/channels/7/read').map((c) => c.body)).toEqual([{ message_id: 11 }])
    expect(badge('general')).toBeNull()
    expect(badge('random')?.textContent).toBe('99')
  })

  it('lists rooms (not joined ones muted) and conversations by their other members', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'GET /api/v1/channels': () => ({
          body: [
            channel(1, { name: 'general' }),
            channel(2, { name: 'secret', kind: 'private' }),
            channel(3, { name: 'random', is_member: false, unread_count: 0 }),
            channel(4, { name: null, kind: 'dm', members: [{ id: ME.id, name: ME.name, avatar_url: null }, NOAM] }),
            channel(5, { name: null, kind: 'group_dm', members: [{ id: ME.id, name: ME.name, avatar_url: null }, DANA, NOAM] }),
          ],
        }),
      }).fetch,
    )
    await createChat({ api, realtime: null }).start()
    render(<Sidebar currentId={1} />, host)

    const labels = [...host.querySelectorAll('a.nav-item .nav-item__label')].map((l) => l.textContent?.replace(/[⁨⁩]/g, ''))
    expect(labels).toEqual(['general', 'secret', 'random', 'נעם', 'dana, נעם'])
    expect(host.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe('/c/1')
    const random = [...host.querySelectorAll('a.nav-item')][2]
    expect(random.classList.contains('nav-item--muted')).toBe(true)
    expect(random.textContent).toContain('not joined')
    expect(host.querySelector('[aria-label="private channel"]')).not.toBeNull()
  })
})
