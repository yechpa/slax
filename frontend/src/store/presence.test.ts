import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientState } from '../api/client.ts'
import { api } from '../api/endpoints.ts'
import { FakeRealtime, fakeFetch } from '../test/fakes.ts'
import { HEARTBEAT_MS, HIDDEN_HEARTBEAT_MS, IDLE_AFTER_MS, POLL_MS, createPresence } from './presence.ts'
import { personName, resetPeople } from './people.ts'

let visibility: DocumentVisibilityState
/** Pending requests answer (fake timers: no real macrotask to wait for). */
const settle = () => vi.advanceTimersByTimeAsync(0)

function setup() {
  const server = fakeFetch({
    'POST /api/v1/presence/heartbeat': () => ({ status: 204 }),
    'GET /api/v1/presence': ({ query }) => ({
      body: Object.fromEntries(query.getAll('user_ids[]').map((id) => [id, Number(id) % 2 === 0 ? 'online' : 'away'])),
    }),
  })
  vi.stubGlobal('fetch', server.fetch)
  return { presence: createPresence({ api }), server }
}

const heartbeats = (server: ReturnType<typeof fakeFetch>) =>
  server.calls.filter((c) => c.path === '/api/v1/presence/heartbeat').map((c) => (c.body as { active: boolean }).active)

beforeEach(() => {
  vi.useFakeTimers()
  resetClientState()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetPeople()
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
})

describe('presence', () => {
  it('presence_polling_batches_200_ids', async () => {
    const { presence, server } = setup()
    presence.track('list', Array.from({ length: 300 }, (_, i) => i + 1))
    presence.track('members', Array.from({ length: 150 }, (_, i) => i + 301))
    presence.track('dupes', [1, 2, 3])
    await presence.poll()

    const polls = server.calls.filter((c) => c.path === '/api/v1/presence')
    expect(polls.map((c) => c.query.getAll('user_ids[]').length)).toEqual([200, 200, 50])
    expect(new Set(polls.flatMap((c) => c.query.getAll('user_ids[]'))).size).toBe(450)
    expect(presence.stateOf(2)).toBe('online')
    expect(presence.stateOf(449)).toBe('away')
    expect(presence.stateOf(451)).toBeUndefined()

    // Untracked ids are no longer asked for; every 30 s the tracked ones are.
    presence.untrack('list')
    presence.untrack('dupes')
    presence.start(1)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    const later = server.calls.filter((c) => c.path === '/api/v1/presence').slice(3)
    // Once when starting, once 30 s later.
    expect(later.map((c) => c.query.getAll('user_ids[]').length)).toEqual([150, 150])
    presence.stop()
  })

  it('beats every 25 s, says idle after 5 minutes without interaction, slows down when hidden and stops', async () => {
    const { presence, server } = setup()
    presence.start(1)
    await settle()
    expect(heartbeats(server)).toEqual([true])
    expect(presence.stateOf(1)).toBe('online')

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(heartbeats(server)).toEqual([true, true])

    // No interaction for 5 minutes: still pinging, as inactive.
    await vi.advanceTimersByTimeAsync(IDLE_AFTER_MS)
    expect(heartbeats(server).at(-1)).toBe(false)
    expect(presence.stateOf(1)).toBe('away')
    // An interaction: active again at once.
    const count = heartbeats(server).length
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    await settle()
    expect(heartbeats(server)).toHaveLength(count + 1)
    expect(heartbeats(server).at(-1)).toBe(true)

    // Hidden: one slow ping, enough to stay connected.
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    const hiddenFrom = heartbeats(server).length
    await vi.advanceTimersByTimeAsync(HIDDEN_HEARTBEAT_MS - 1)
    expect(heartbeats(server)).toHaveLength(hiddenFrom)
    await vi.advanceTimersByTimeAsync(1)
    expect(heartbeats(server)).toHaveLength(hiddenFrom + 1)
    expect(heartbeats(server).at(-1)).toBe(false)
    // Visible again: a beat right away.
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(heartbeats(server)).toHaveLength(hiddenFrom + 2)

    presence.stop()
    const stopped = server.calls.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(server.calls).toHaveLength(stopped)
  })

  it('follows joins and leaves on the workspace presence channel, and learns names there', () => {
    const { presence } = setup()
    const realtime = new FakeRealtime()
    presence.attach(realtime, 1)
    const listener = realtime.presence.get('presence-workspace.1')!
    listener.members([
      { id: 2, name: 'dana', avatar_url: null },
      { id: 3, name: 'נעם', avatar_url: null },
    ])
    expect([presence.stateOf(2), presence.stateOf(3)]).toEqual(['online', 'online'])
    expect(personName(3)).toBe('נעם')
    listener.removed(2)
    expect(presence.stateOf(2)).toBe('offline')
    listener.added({ id: 2, name: 'dana', avatar_url: null })
    expect(presence.stateOf(2)).toBe('online')
    presence.stop()
    expect(realtime.presence.size).toBe(0)
  })
})
