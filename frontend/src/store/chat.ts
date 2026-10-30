/**
 * The chat controller: everything that changes the stores. Components read signals and
 * call these functions; they never talk to the API or the socket themselves.
 *
 * Data flow for a message: REST pages, the POST response and realtime events all go
 * through `mergeMessages` (see merge.ts), so they can overlap and arrive in any order.
 *
 * - Sending is optimistic: a pending entry keyed by a fresh client_id (UUID) shows at
 *   once; the server copy replaces it when the POST answers or when `message.created`
 *   comes first. A failure leaves it in place with a retry that reuses the same
 *   client_id, which the server deduplicates (200 replay), so a retry never doubles.
 * - Realtime: one private channel per channel the user is a member of. Events missed
 *   while the socket was down are never replayed, so on reconnect the current channel
 *   catches up with `after=<newest id>` (missed messages) and refetches its latest page
 *   (edits, deletions and reactions of what is on screen); other timelines are marked
 *   stale and refetched when opened; the channel list is refetched for unread counts.
 *   A refresh that fails keeps live events flowing and is retried with backoff
 *   (1 s, 2 s, 4 s… at most 30 s) while the channel stays open; after 3 failures the
 *   view offers a Retry.
 * - While a latest page is on its way, events for that channel are held and applied
 *   after it, through the same merge, so none is lost and none is undone by the page.
 * - Nothing that finishes after `stop()` (sign-out) touches the stores.
 */
import { batch } from '@preact/signals'
import { isApiError } from '../api/client.ts'
import type { Api } from '../api/endpoints.ts'
import type { Channel, Message } from '../api/types.ts'
import type { Realtime } from '../realtime/echo.ts'
import { bumpUnread, channelById, channels, markReadLocally, setChannels, setUnread, upsertChannel } from './channels.ts'
import {
  addPending,
  findPending,
  mergeMessages,
  newestId,
  oldestId,
  pendingEntry,
  removePending,
  resetTo,
  updatePending,
} from './merge.ts'
import { channelKey, peekTimeline, timelineKeys, updateTimeline } from './messages.ts'
import { me } from './session.ts'

export const PAGE_SIZE = 50
/** Catch-up after a reconnection: up to this many pages of 100 before giving up on continuity. */
const CATCH_UP_PAGES = 4
export const READ_DEBOUNCE_MS = 1000
/** Retry delays after a failed refresh: doubling from the first, capped. */
export const RETRY_FIRST_MS = 1000
export const RETRY_MAX_MS = 30_000
/** Failures after which the view says so and offers a Retry. */
export const FAILURES_BEFORE_NOTICE = 3
const MESSAGE_EVENTS = ['message.created', 'message.updated', 'message.deleted', 'reaction.changed'] as const

export interface ChatDeps {
  api: Api
  realtime: Realtime | null
  uuid?: () => string
  now?: () => Date
}

export type Chat = ReturnType<typeof createChat>

export function createChat({ api, realtime: initialRealtime, uuid = () => crypto.randomUUID(), now = () => new Date() }: ChatDeps) {
  let realtime = initialRealtime
  const subscriptions = new Map<number, () => void>()
  /** Refused subscriptions per channel since the last reconnection (retried once, then left alone). */
  const refusals = new Map<number, number>()
  const loads = new Map<number, AbortController>()
  const readTimers = new Map<number, ReturnType<typeof setTimeout>>()
  /** Still readable when the debounce ends? (visible, focused, at the bottom), per channel. */
  const readChecks = new Map<number, () => boolean>()
  /** Events received while a latest page is on its way, applied after it. */
  const held = new Map<number, Message[]>()
  /** Failed refreshes of the open channel: consecutive failures and the pending retry. */
  const retries = new Map<number, { failures: number; timer?: ReturnType<typeof setTimeout> }>()
  /** Bumped by stop(): anything that finishes under an older generation is ignored. */
  let generation = 0
  /** Message ids already counted as unread, so a repeated event never counts twice. */
  const counted = new Set<number>()
  let current: number | null = null
  let stopReconnect: (() => void) | null = null

  const meId = () => me.peek()?.id ?? null

  async function refreshChannels(): Promise<void> {
    const started = generation
    const list = await api.channels()
    if (started !== generation) return
    setChannels(list)
    syncSubscriptions()
  }

  /** Subscribed to exactly the channels the user is a member of. */
  function syncSubscriptions(): void {
    if (!realtime) return
    const wanted = new Set(channels.peek().filter((c) => c.is_member).map((c) => c.id))
    for (const [id, unsubscribe] of subscriptions) {
      if (!wanted.has(id)) {
        unsubscribe()
        subscriptions.delete(id)
      }
    }
    for (const id of wanted) {
      if (subscriptions.has(id) || (refusals.get(id) ?? 0) >= 2) continue
      const handlers = Object.fromEntries(MESSAGE_EVENTS.map((event) => [event, (payload: unknown) => onMessageEvent(id, event, payload)]))
      subscriptions.set(
        id,
        realtime.subscribe(`private-channel.${id}`, handlers, () => {
          // Refused: no longer a member, channel gone, or a passing failure. Drop it; the
          // refreshed list tells whether to subscribe again (once).
          subscriptions.get(id)?.()
          subscriptions.delete(id)
          refusals.set(id, (refusals.get(id) ?? 0) + 1)
          void refreshChannels().catch(() => undefined)
        }),
      )
    }
  }

  function onMessageEvent(channelId: number, event: (typeof MESSAGE_EVENTS)[number], payload: unknown): void {
    if (!isMessage(payload) || payload.channel_id !== channelId || !channelById.peek().has(channelId)) return
    // Thread replies live in their thread (part B), not in the channel timeline.
    if (payload.parent_id !== null) return
    const message = fromBroadcast(payload, channelId)
    const key = channelKey(channelId)
    const loaded = peekTimeline(key)
    const known = loaded?.entries.some((e) => e.kind === 'server' && e.message.id === message.id) ?? false
    batch(() => {
      if (loads.has(channelId)) {
        // A latest page is on its way: applied after it (see loadLatest).
        held.get(channelId)?.push(message)
      } else if (loaded && loaded.status !== 'idle' && !loaded.stale) {
        updateTimeline(key, (t) => withEntries(t, mergeMessages(t.entries, [message], meId())))
      }
      const mine = !message.deleted && message.user.id === meId()
      if (event === 'message.created' && !known && !mine && channelId !== current && !counted.has(message.id)) {
        counted.add(message.id)
        if (counted.size > 1000) counted.delete(counted.values().next().value!)
        bumpUnread(channelId)
      }
    })
  }

  /**
   * Broadcasts are rendered once for every member, so `reacted_by_me` is always false
   * there: derive it from the reactor ids (the first 50), keeping what we knew when the
   * list is truncated.
   */
  function fromBroadcast(message: Message, channelId: number): Message {
    if (message.deleted) return message
    const id = meId()
    const previous = peekTimeline(channelKey(channelId))?.entries.find((e) => e.kind === 'server' && e.message.id === message.id)
    const before = previous?.kind === 'server' && !previous.message.deleted ? previous.message.reactions : []
    return {
      ...message,
      reactions: message.reactions.map((r) => ({
        ...r,
        reacted_by_me:
          (id !== null && r.user_ids.includes(id)) ||
          (r.count > r.user_ids.length && (before.find((b) => b.emoji === r.emoji)?.reacted_by_me ?? false)),
      })),
    }
  }

  /** Shows a channel: loads its latest page unless it is already loaded and fresh. */
  function openChannel(channelId: number): void {
    current = channelId
    const t = peekTimeline(channelKey(channelId))
    if (!t || t.status === 'idle' || t.status === 'error' || t.stale) void loadLatest(channelId)
  }

  /**
   * Leaving a channel: messages that arrived while it was open but were never scrolled to
   * (no read pointer move) become its unread count, computed from what is loaded.
   */
  function closeChannel(channelId: number): void {
    if (current === channelId) current = null
    // A refresh still being retried: give up for now, the next opening refetches.
    if (retries.has(channelId)) {
      clearTimeout(retries.get(channelId)!.timer)
      retries.delete(channelId)
      updateTimeline(channelKey(channelId), (t) => ({ ...t, stale: true, refreshFailed: false }))
    }
    // The reader was at the bottom a moment ago: that read counts now, not a second later.
    const pendingRead = readTimers.get(channelId)
    if (pendingRead !== undefined) {
      clearTimeout(pendingRead)
      readTimers.delete(channelId)
      const stillReadable = readChecks.get(channelId)
      readChecks.delete(channelId)
      if (!stillReadable || stillReadable()) {
        void markRead(channelId)
        return
      }
    }
    const channel = channelById.peek().get(channelId)
    const t = peekTimeline(channelKey(channelId))
    if (!channel?.is_member || !t || t.status !== 'ready') return
    const pointer = channel.last_read_message_id ?? 0
    const id = meId()
    const unseen = t.entries.filter((e) => e.kind === 'server' && !e.message.deleted && e.message.id > pointer && e.message.user.id !== id).length
    if (unseen > channel.unread_count) setUnread(channelId, unseen)
  }

  /**
   * The latest page, replacing the window (first load, stale timeline, gap too large).
   * Events arriving meanwhile are held and merged after the page, so an event the
   * page's query did not see yet is kept, and one it did see is not undone.
   */
  async function loadLatest(channelId: number): Promise<void> {
    const key = channelKey(channelId)
    const started = generation
    loads.get(channelId)?.abort()
    const controller = new AbortController()
    loads.set(channelId, controller)
    if (!held.has(channelId)) held.set(channelId, [])
    updateTimeline(key, (t) => (t.status === 'ready' ? t : { ...t, status: 'loading' }))
    try {
      const page = await api.messages(channelId, { limit: PAGE_SIZE }, controller.signal)
      if (started !== generation) return
      const events = takeHeld(channelId)
      updateTimeline(key, (t) => ({
        ...t,
        entries: mergeMessages(resetTo(t.entries, page.data.filter(isTopLevel), meId()), events, meId()),
        hasMoreBefore: page.has_more,
        status: 'ready',
        stale: false,
        refreshFailed: false,
      }))
      refreshed(channelId)
    } catch (error) {
      // Aborted by a newer load, which keeps the held events.
      if (isApiError(error, 'aborted') || started !== generation) return
      const events = takeHeld(channelId)
      const before = peekTimeline(key)
      updateTimeline(key, (t) => {
        if (t.status !== 'ready') return { ...t, status: 'error', entries: mergeMessages(t.entries, events, meId()) }
        // A stale window would show a gap with events after it: they come with the retry.
        return t.stale ? t : withEntries(t, mergeMessages(t.entries, events, meId()))
      })
      if (before?.status === 'ready') refreshFailed(channelId)
    } finally {
      if (loads.get(channelId) === controller) loads.delete(channelId)
    }
  }

  function takeHeld(channelId: number): Message[] {
    const events = held.get(channelId) ?? []
    held.delete(channelId)
    return events
  }

  /** Brings the open channel up to date: catch-up when its window is sound, else a fresh page. */
  function refresh(channelId: number): Promise<void> {
    const t = peekTimeline(channelKey(channelId))
    return t && t.status === 'ready' && !t.stale ? catchUp(channelId) : loadLatest(channelId)
  }

  function refreshed(channelId: number): void {
    const retry = retries.get(channelId)
    if (!retry) return
    clearTimeout(retry.timer)
    retries.delete(channelId)
  }

  /** A refresh of the open channel failed: try again later (backoff), say so after a few. */
  function refreshFailed(channelId: number): void {
    if (channelId !== current) {
      updateTimeline(channelKey(channelId), (t) => (t.status === 'idle' ? t : { ...t, stale: true }))
      return
    }
    const retry = retries.get(channelId) ?? { failures: 0 }
    retry.failures += 1
    clearTimeout(retry.timer)
    const delay = Math.min(RETRY_FIRST_MS * 2 ** (retry.failures - 1), RETRY_MAX_MS)
    retry.timer = setTimeout(() => void refresh(channelId), delay)
    retries.set(channelId, retry)
    if (retry.failures >= FAILURES_BEFORE_NOTICE) updateTimeline(channelKey(channelId), (t) => ({ ...t, refreshFailed: true }))
  }

  /** The view's Retry: now, without waiting for the next backoff step. */
  function retryRefresh(channelId: number): void {
    clearTimeout(retries.get(channelId)?.timer)
    void refresh(channelId)
  }

  /**
   * Infinite scroll upwards: the page just older than what is loaded. After a failure,
   * scrolling no longer retries by itself (it would hammer the server on every scroll
   * event): the view shows a Retry, which passes `force`.
   */
  async function loadOlder(channelId: number, { force = false } = {}): Promise<void> {
    const key = channelKey(channelId)
    const t = peekTimeline(key)
    const before = t ? oldestId(t.entries) : null
    if (!t || t.status !== 'ready' || t.loadingOlder || !t.hasMoreBefore || before === null) return
    if (t.olderFailed && !force) return
    const started = generation
    updateTimeline(key, (x) => ({ ...x, loadingOlder: true, olderFailed: false }))
    try {
      const page = await api.messages(channelId, { before, limit: PAGE_SIZE })
      if (started !== generation) return
      updateTimeline(key, (x) => ({
        ...x,
        entries: mergeMessages(x.entries, page.data.filter(isTopLevel), meId()),
        hasMoreBefore: page.has_more,
        loadingOlder: false,
      }))
    } catch {
      if (started !== generation) return
      updateTimeline(key, (x) => ({ ...x, loadingOlder: false, olderFailed: true }))
    }
  }

  /** Optimistic send. Returns the client_id of the new message. */
  function send(channelId: number, body: string): string {
    const clientId = uuid().toLowerCase()
    const entry = pendingEntry(channelId, clientId, body, now().toISOString())
    updateTimeline(channelKey(channelId), (t) => withEntries(t, addPending(t.entries, entry)))
    void deliver(channelId, clientId)
    return clientId
  }

  /** Sends a failed message again, under the same client_id (the server deduplicates). */
  function retry(channelId: number, clientId: string): void {
    const key = channelKey(channelId)
    const t = peekTimeline(key)
    if (!t || findPending(t.entries, clientId)?.status !== 'failed') return
    updateTimeline(key, (x) => withEntries(x, updatePending(x.entries, clientId, { status: 'sending', error: null })))
    void deliver(channelId, clientId)
  }

  function discard(channelId: number, clientId: string): void {
    updateTimeline(channelKey(channelId), (t) => withEntries(t, removePending(t.entries, clientId)))
  }

  async function deliver(channelId: number, clientId: string): Promise<void> {
    const key = channelKey(channelId)
    const pending = findPending(peekTimeline(key)?.entries ?? [], clientId)
    if (!pending) return
    const started = generation
    try {
      const message = await api.postMessage(channelId, { body: pending.body, client_id: clientId, parent_id: pending.parentId })
      if (started !== generation) return
      updateTimeline(key, (t) => withEntries(t, mergeMessages(t.entries, [message], meId())))
    } catch (error) {
      if (started !== generation) return
      // Still pending unless the realtime copy confirmed it meanwhile (then this is a no-op).
      updateTimeline(key, (t) =>
        withEntries(t, updatePending(t.entries, clientId, { status: 'failed', error: isApiError(error) ? error.code : 'network' })),
      )
    }
  }

  /**
   * The view calls this while the channel is visible, focused and scrolled to the bottom.
   * After a quiet second, and if `stillReadable()` still says so then (the tab may have
   * been hidden, the window left, the list scrolled up meanwhile), the newest message
   * becomes the read pointer: locally at once, then on the server.
   */
  function noteReadable(channelId: number, stillReadable?: () => boolean): void {
    clearTimeout(readTimers.get(channelId))
    if (stillReadable) readChecks.set(channelId, stillReadable)
    else readChecks.delete(channelId)
    readTimers.set(
      channelId,
      setTimeout(() => {
        readTimers.delete(channelId)
        const check = readChecks.get(channelId)
        readChecks.delete(channelId)
        if (check && !check()) return
        void markRead(channelId)
      }, READ_DEBOUNCE_MS),
    )
  }

  async function markRead(channelId: number): Promise<void> {
    const channel = channelById.peek().get(channelId)
    const t = peekTimeline(channelKey(channelId))
    if (!channel?.is_member || !t) return
    const newest = newestId(t.entries)
    if (newest === 0) return
    if (channel.last_read_message_id !== null && channel.last_read_message_id >= newest && channel.unread_count === 0) return
    markReadLocally(channelId, newest)
    try {
      await api.markRead(channelId, newest)
    } catch {
      // Harmless: the next read or the next list refresh settles it.
    }
  }

  async function join(channelId: number): Promise<Channel> {
    const channel = await api.joinChannel(channelId)
    upsertChannel(channel)
    syncSubscriptions()
    return channel
  }

  /** After the socket came back: see the module comment. */
  async function reconnect(): Promise<void> {
    refusals.clear()
    for (const key of timelineKeys()) {
      if (key !== (current === null ? '' : channelKey(current))) updateTimeline(key, (t) => (t.status === 'idle' ? t : { ...t, stale: true }))
    }
    await Promise.all([refreshChannels().catch(() => undefined), current === null ? undefined : catchUp(current)])
  }

  async function catchUp(channelId: number): Promise<void> {
    const key = channelKey(channelId)
    const t = peekTimeline(key)
    if (!t || t.status !== 'ready') {
      await loadLatest(channelId)
      return
    }
    const after = newestId(t.entries)
    const started = generation
    try {
      const [latest, missed] = await Promise.all([api.messages(channelId, { limit: PAGE_SIZE }), fetchAfter(channelId, after)])
      if (started !== generation) return
      updateTimeline(key, (x) => {
        if (!missed.complete) {
          // Too much happened meanwhile: start again from the latest page.
          return {
            ...x,
            entries: resetTo(x.entries, latest.data.filter(isTopLevel), meId()),
            hasMoreBefore: latest.has_more,
            stale: false,
            refreshFailed: false,
          }
        }
        const repaired = mergeMessages(x.entries, [...missed.messages, ...latest.data].filter(isTopLevel), meId())
        return { ...withEntries(x, repaired), stale: false, refreshFailed: false }
      })
      refreshed(channelId)
    } catch {
      if (started !== generation) return
      // The window stays sound and live events keep merging; the catch-up is retried.
      refreshFailed(channelId)
    }
  }

  async function fetchAfter(channelId: number, after: number): Promise<{ messages: Message[]; complete: boolean }> {
    const messages: Message[] = []
    let cursor = after
    for (let page = 0; page < CATCH_UP_PAGES; page += 1) {
      const result = await api.messages(channelId, { after: cursor, limit: 100 })
      messages.push(...result.data)
      if (!result.has_more || result.data.length === 0) return { messages, complete: true }
      cursor = result.data[result.data.length - 1].id
    }
    return { messages, complete: false }
  }

  /** Signed in: channel list, subscriptions, reconnect hook. */
  async function start(): Promise<void> {
    if (realtime) attachRealtime(realtime)
    await refreshChannels()
  }

  /** The socket can come later than the first render (pusher-js is loaded on demand). */
  function attachRealtime(next: Realtime): void {
    stopReconnect?.()
    realtime = next
    stopReconnect = next.onReconnect(() => void reconnect())
    syncSubscriptions()
  }

  function stop(): void {
    generation += 1
    stopReconnect?.()
    stopReconnect = null
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear()
    refusals.clear()
    for (const controller of loads.values()) controller.abort()
    loads.clear()
    for (const timer of readTimers.values()) clearTimeout(timer)
    readTimers.clear()
    readChecks.clear()
    held.clear()
    for (const retry of retries.values()) clearTimeout(retry.timer)
    retries.clear()
    current = null
  }

  return {
    start,
    stop,
    attachRealtime,
    refreshChannels,
    openChannel,
    closeChannel,
    loadLatest,
    loadOlder,
    retryRefresh,
    send,
    retry,
    discard,
    noteReadable,
    markRead,
    join,
    reconnect,
    /** Exposed for tests and for the realtime fake. */
    onMessageEvent,
  }
}

const withEntries = <T extends { entries: unknown }>(t: T, entries: T['entries']): T => (entries === t.entries ? t : { ...t, entries })

const isTopLevel = (message: Message) => message.parent_id === null

function isMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Partial<Message>
  return typeof m.id === 'number' && typeof m.channel_id === 'number' && typeof m.created_at === 'string' && typeof m.deleted === 'boolean'
}
