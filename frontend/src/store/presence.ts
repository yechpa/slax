/**
 * Who is online, away or offline (the server derives it from heartbeats; see
 * backend PresenceService for the contract).
 *
 * - Heartbeat: `POST /presence/heartbeat {active}` now and every 25 s; `active` is an
 *   interaction (key, pointer, focus) in the last 5 minutes. A hidden tab keeps one slow
 *   ping (every 50 s, under the server's 60 s window) as inactive; coming back beats at
 *   once, and so does the first interaction after a while idle. Stops with the session.
 * - Polling: `GET /presence` every 30 s for the people on screen (what components track),
 *   in batches of 200 ids, the server's limit. Newly shown people are asked for shortly.
 * - The workspace presence channel tells joins and leaves at once, and the names of the
 *   people connected. A leave is trusted over the polls for a minute: the server keeps the
 *   last heartbeat that long and would otherwise bring a closed app back "online".
 * My own state is known locally: online while active, away when idle.
 */
import { signal } from '@preact/signals'
import type { Api } from '../api/endpoints.ts'
import type { PresenceState } from '../api/types.ts'
import type { Realtime } from '../realtime/echo.ts'
import { rememberPeople } from './people.ts'

export const HEARTBEAT_MS = 25_000
export const HIDDEN_HEARTBEAT_MS = 50_000
export const POLL_MS = 30_000
export const IDLE_AFTER_MS = 5 * 60_000
export const BATCH = 200
/** The server forgets a connection a minute after its last heartbeat (PresenceService::CONNECTION_TTL). */
export const LEFT_TRUST_MS = 60_000
/** A newly shown person is asked for after this pause (several lists appear at once). */
const SOON_MS = 300

const ACTIVITY = ['keydown', 'pointerdown', 'focusin', 'wheel', 'touchstart'] as const

export type Presence = ReturnType<typeof createPresence>

export function createPresence({ api }: { api: Api }) {
  const states = signal<ReadonlyMap<number, PresenceState>>(new Map())
  const tracked = new Map<string, readonly number[]>()
  const asked = new Set<number>()
  /** When the presence channel said someone left (their polls may say "online" for a while). */
  const leftAt = new Map<number, number>()
  let meId: number | null = null
  let lastActivity = Date.now()
  let beatTimer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let soonTimer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let unsubscribe: (() => void) | null = null

  const hidden = () => globalThis.document?.visibilityState === 'hidden'
  const isActive = () => !hidden() && Date.now() - lastActivity < IDLE_AFTER_MS

  function set(changes: Iterable<[number, PresenceState]>): void {
    const current = states.peek()
    let next: Map<number, PresenceState> | null = null
    for (const [id, state] of changes) {
      if ((next ?? current).get(id) === state) continue
      next ??= new Map(current)
      next.set(id, state)
    }
    if (next) states.value = next
  }

  async function beat(): Promise<void> {
    clearTimeout(beatTimer)
    if (!running) return
    const active = isActive()
    if (meId !== null) set([[meId, active ? 'online' : 'away']])
    beatTimer = setTimeout(() => void beat(), hidden() ? HIDDEN_HEARTBEAT_MS : HEARTBEAT_MS)
    try {
      await api.heartbeat(active)
    } catch {
      // The next beat tries again; presence is never worth an error message.
    }
  }

  function onActivity(): void {
    const wasIdle = Date.now() - lastActivity >= IDLE_AFTER_MS
    lastActivity = Date.now()
    if (wasIdle && running && !hidden()) void beat()
  }

  function onVisibility(): void {
    if (!running) return
    if (hidden()) {
      clearTimeout(beatTimer)
      beatTimer = setTimeout(() => void beat(), HIDDEN_HEARTBEAT_MS)
    } else {
      lastActivity = Date.now()
      void beat()
      void poll()
    }
  }

  /** Every tracked id, asked for in batches of 200. */
  async function poll(): Promise<void> {
    clearTimeout(soonTimer)
    const ids = [...new Set([...tracked.values()].flat())].filter((id) => id !== meId)
    for (const id of ids) asked.add(id)
    const batches: number[][] = []
    for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH))
    const answers = await Promise.all(batches.map((batch) => api.presence(batch).catch(() => ({}) as Record<string, PresenceState>)))
    set(
      answers.flatMap((answer) =>
        Object.entries(answer)
          .filter(([, state]) => state === 'online' || state === 'away' || state === 'offline')
          .map(([id, state]) => [Number(id), state] as [number, PresenceState])
          .filter(([id, state]) => state === 'offline' || !justLeft(id)),
      ),
    )
  }

  function justLeft(id: number): boolean {
    const at = leftAt.get(id)
    if (at === undefined) return false
    if (Date.now() - at < LEFT_TRUST_MS) return true
    leftAt.delete(id)
    return false
  }

  function schedulePoll(): void {
    clearTimeout(pollTimer)
    if (!running) return
    pollTimer = setTimeout(async () => {
      if (!hidden()) await poll()
      schedulePoll()
    }, POLL_MS)
  }

  /** The people a component shows (replaces what it showed before under the same key). */
  function track(key: string, ids: readonly number[]): void {
    tracked.set(key, ids)
    if (running && ids.some((id) => id !== meId && !asked.has(id))) {
      clearTimeout(soonTimer)
      soonTimer = setTimeout(() => void poll(), SOON_MS)
    }
  }

  function untrack(key: string): void {
    tracked.delete(key)
  }

  function start(me: number): void {
    if (running) return
    running = true
    meId = me
    lastActivity = Date.now()
    for (const event of ACTIVITY) document.addEventListener(event, onActivity, { capture: true, passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    void beat()
    void poll()
    schedulePoll()
  }

  /** The workspace presence channel: connections and disconnections as they happen. */
  function attach(realtime: Realtime, workspaceId: number | null): void {
    unsubscribe?.()
    unsubscribe = null
    if (workspaceId === null) return
    const connected = (id: number) => (states.peek().get(id) === 'away' ? 'away' : 'online') as PresenceState
    unsubscribe = realtime.subscribePresence(`presence-workspace.${workspaceId}`, {
      members(members) {
        rememberPeople(members)
        for (const m of members) leftAt.delete(m.id)
        set(members.filter((m) => m.id !== meId).map((m) => [m.id, connected(m.id)]))
      },
      added(member) {
        rememberPeople([member])
        leftAt.delete(member.id)
        if (member.id !== meId) set([[member.id, connected(member.id)]])
      },
      removed(id) {
        if (id === meId) return
        leftAt.set(id, Date.now())
        set([[id, 'offline']])
      },
    })
  }

  function stop(): void {
    running = false
    clearTimeout(beatTimer)
    clearTimeout(pollTimer)
    clearTimeout(soonTimer)
    for (const event of ACTIVITY) document.removeEventListener(event, onActivity, { capture: true })
    document.removeEventListener('visibilitychange', onVisibility)
    unsubscribe?.()
    unsubscribe = null
    tracked.clear()
    asked.clear()
    leftAt.clear()
    states.value = new Map()
  }

  const stateOf = (id: number): PresenceState | undefined => states.value.get(id)

  return { states, stateOf, start, attach, stop, track, untrack, poll }
}
