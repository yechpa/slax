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
 * - Threads (threads.ts), reactions (reactions.ts) and uploads (uploads.ts) have their own
 *   modules; this one routes the events to them and owns the sending of messages.
 */
import { batch } from '@preact/signals'
import { isApiError } from '../api/client.ts'
import type { Api } from '../api/endpoints.ts'
import type { Channel, FileInfo, Message } from '../api/types.ts'
import type { UploadFn } from '../api/upload.ts'
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
import { applyKnown, channelKey, findMessage, peekTimeline, threadKey, timelineKeys, updateTimeline } from './messages.ts'
import { createReactions } from './reactions.ts'
import { me } from './session.ts'
import { createThreads, type ReplyEvent } from './threads.ts'
import { createUploads } from './uploads.ts'

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
  /** File uploads (XMLHttpRequest by default). */
  upload?: UploadFn
}

interface HeldEvent {
  event: ReplyEvent
  message: Message
}

export interface SendOptions {
  /** Replying in this thread. */
  parentId?: number | null
  /** Finished uploads to attach (the body may then be empty). */
  files?: FileInfo[]
}

export type Chat = ReturnType<typeof createChat>

export function createChat({ api, realtime: initialRealtime, uuid = () => crypto.randomUUID(), now = () => new Date(), upload }: ChatDeps) {
  let realtime = initialRealtime
  const subscriptions = new Map<number, () => void>()
  /** Refused subscriptions per channel since the last reconnection (retried once, then left alone). */
  const refusals = new Map<number, number>()
  const loads = new Map<number, AbortController>()
  const readTimers = new Map<number, ReturnType<typeof setTimeout>>()
  /** Still readable when the debounce ends? (visible, focused, at the bottom), per channel. */
  const readChecks = new Map<number, () => boolean>()
  /** Events received while a latest page is on its way, applied after it. */
  const held = new Map<number, HeldEvent[]>()
  /** Failed refreshes of the open channel: consecutive failures and the pending retry. */
  const retries = new Map<number, { failures: number; timer?: ReturnType<typeof setTimeout> }>()
  /** Bumped by stop(): anything that finishes under an older generation is ignored. */
  let generation = 0
  /** Message ids already counted as unread, so a repeated event never counts twice. */
  const counted = new Set<number>()
  let current: number | null = null
  let stopReconnect: (() => void) | null = null

  const meId = () => me.peek()?.id ?? null
  /** A check that turns false once stop() ran (whatever started now must then not touch the stores). */
  const alive = () => {
    const started = generation
    return () => started === generation
  }
  const reactions = createReactions({ api, meId, alive })
  const threads = createThreads({ api, meId, alive, prepare: (message) => reactions.overlay(message) })
  const uploads = createUploads({ upload })

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
    const message = reactions.overlay(fromBroadcast(payload))
    if (message.parent_id !== null) {
      // A reply: into its thread, and its parent's summary (held with the channel's page if one is coming).
      batch(() => {
        threads.onReply(message)
        if (loads.has(channelId)) held.get(channelId)?.push({ event, message })
        else threads.noteReply(message, event)
      })
      return
    }
    const key = channelKey(channelId)
    const loaded = peekTimeline(key)
    const known = loaded?.entries.some((e) => e.kind === 'server' && e.message.id === message.id) ?? false
    batch(() => {
      threads.onParent(message)
      if (loads.has(channelId)) {
        // A latest page is on its way: applied after it (see loadLatest).
        held.get(channelId)?.push({ event, message })
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
  function fromBroadcast(message: Message): Message {
    if (message.deleted) return message
    const id = meId()
    const previous = findMessage(message.id)
    const before = previous && !previous.deleted ? previous.reactions : []
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
      batch(() => {
        updateTimeline(key, (t) => ({
          ...t,
          entries: mergeMessages(resetTo(t.entries, prepared(page.data), meId()), topLevel(events), meId()),
          hasMoreBefore: page.has_more,
          status: 'ready',
          stale: false,
          refreshFailed: false,
        }))
        noteHeldReplies(events)
      })
      refreshed(channelId)
    } catch (error) {
      // Aborted by a newer load, which keeps the held events.
      if (isApiError(error, 'aborted') || started !== generation) return
      const events = takeHeld(channelId)
      const before = peekTimeline(key)
      const top = topLevel(events)
      updateTimeline(key, (t) => {
        if (t.status !== 'ready') return { ...t, status: 'error', entries: mergeMessages(t.entries, top, meId()) }
        // A stale window would show a gap with events after it: they come with the retry.
        return t.stale ? t : withEntries(t, mergeMessages(t.entries, top, meId()))
      })
      noteHeldReplies(events)
      if (before?.status === 'ready') refreshFailed(channelId)
    } finally {
      if (loads.get(channelId) === controller) loads.delete(channelId)
    }
  }

  function takeHeld(channelId: number): HeldEvent[] {
    const events = held.get(channelId) ?? []
    held.delete(channelId)
    return events
  }

  /** Server messages ready to merge into a channel timeline: top-level, my reactions in flight laid over. */
  const prepared = (messages: readonly Message[]) => messages.filter(isTopLevel).map(reactions.overlay)
  const topLevel = (events: readonly HeldEvent[]) => events.filter((e) => e.message.parent_id === null).map((e) => e.message)
  function noteHeldReplies(events: readonly HeldEvent[]): void {
    for (const { event, message } of events) if (message.parent_id !== null) threads.noteReply(message, event, { held: true })
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
        entries: mergeMessages(x.entries, prepared(page.data), meId()),
        hasMoreBefore: page.has_more,
        loadingOlder: false,
      }))
    } catch {
      if (started !== generation) return
      updateTimeline(key, (x) => ({ ...x, loadingOlder: false, olderFailed: true }))
    }
  }

  /** Where a message goes: its thread, or the channel. */
  const targetKey = (channelId: number, parentId: number | null | undefined) => (parentId ? threadKey(parentId) : channelKey(channelId))

  /**
   * Optimistic send, to the channel or (parentId) a thread, with finished uploads attached.
   * The body may be empty when files go with it, as the server allows. Returns the client_id.
   */
  function send(channelId: number, body: string, { parentId = null, files = [] }: SendOptions = {}): string {
    const clientId = uuid().toLowerCase()
    const entry = pendingEntry(channelId, clientId, body, now().toISOString(), parentId, files)
    updateTimeline(targetKey(channelId, parentId), (t) => withEntries(t, addPending(t.entries, entry)))
    void deliver(channelId, clientId, parentId)
    return clientId
  }

  /** Sends a failed message again, under the same client_id (the server deduplicates). */
  function retry(channelId: number, clientId: string, parentId: number | null = null): void {
    const key = targetKey(channelId, parentId)
    const t = peekTimeline(key)
    if (!t || findPending(t.entries, clientId)?.status !== 'failed') return
    updateTimeline(key, (x) => withEntries(x, updatePending(x.entries, clientId, { status: 'sending', error: null })))
    void deliver(channelId, clientId, parentId)
  }

  function discard(channelId: number, clientId: string, parentId: number | null = null): void {
    updateTimeline(targetKey(channelId, parentId), (t) => withEntries(t, removePending(t.entries, clientId)))
  }

  async function deliver(channelId: number, clientId: string, parentId: number | null): Promise<void> {
    const key = targetKey(channelId, parentId)
    const pending = findPending(peekTimeline(key)?.entries ?? [], clientId)
    if (!pending) return
    const started = generation
    try {
      const message = reactions.overlay(
        await api.postMessage(channelId, {
          body: pending.body,
          client_id: clientId,
          parent_id: pending.parentId,
          ...(pending.files.length > 0 ? { file_ids: pending.files.map((f) => f.id) } : {}),
        }),
      )
      if (started !== generation) return
      batch(() => {
        updateTimeline(key, (t) => withEntries(t, mergeMessages(t.entries, [message], meId())))
        if (message.parent_id !== null) threads.noteReply(message, 'message.created')
      })
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

  /** Saves an edit (not optimistic: the server's time stamps the edit). Errors go to the caller. */
  async function editMessage(messageId: number, body: string): Promise<void> {
    const still = alive()
    const message = await api.editMessage(messageId, body)
    if (still()) applyKnown(reactions.overlay(message))
  }

  /** Deletes a message: it becomes a tombstone everywhere (a reply leaves its parent's count). */
  async function deleteMessage(messageId: number): Promise<void> {
    const still = alive()
    const message = await api.deleteMessage(messageId)
    if (!still()) return
    batch(() => {
      applyKnown(message)
      threads.onParent(message)
      if (message.parent_id !== null) threads.noteReply(message, 'message.deleted')
    })
  }

  /** Opens a thread beside its channel (the parent shows at once when we have it). */
  function openThread(channelId: number, parentId: number): void {
    threads.open(channelId, parentId, findMessage(parentId))
  }

  /** A new room: listed and subscribed at once. */
  async function createChannel(input: { name: string; kind: 'public' | 'private'; topic: string | null }): Promise<Channel> {
    const channel = await api.createChannel(input)
    upsertChannel(channel)
    syncSubscriptions()
    return channel
  }

  /** A conversation with these people: the existing one (200) or a new one (201), listed and subscribed. */
  async function openConversation(userIds: number[]): Promise<{ channel: Channel; created: boolean }> {
    const { status, body } = await api.openConversation(userIds)
    upsertChannel(body)
    syncSubscriptions()
    return { channel: body, created: status === 201 }
  }

  /**
   * Leaves a room. A public one stays listed (not joined, readable); a private one goes.
   * Its timeline will be refetched when opened again (events stop with the subscription).
   */
  async function leave(channelId: number): Promise<void> {
    await api.leaveChannel(channelId)
    updateTimeline(channelKey(channelId), (t) => (t.status === 'idle' ? t : { ...t, stale: true }))
    const channel = channelById.peek().get(channelId)
    if (channel?.kind === 'public') upsertChannel({ ...channel, is_member: false, unread_count: 0, member_count: Math.max(0, channel.member_count - 1) })
    else setChannels(channels.peek().filter((c) => c.id !== channelId))
    syncSubscriptions()
    await refreshChannels().catch(() => undefined)
  }

  /** One channel again from the server (its member count after a change of members). */
  async function refreshChannel(channelId: number): Promise<void> {
    const still = alive()
    const channel = await api.channel(channelId)
    if (still()) upsertChannel(channel)
  }

  /** After the socket came back: see the module comment. */
  async function reconnect(): Promise<void> {
    refusals.clear()
    for (const key of timelineKeys()) {
      if (key === (current === null ? '' : channelKey(current)) || threads.isOpen(key)) continue
      updateTimeline(key, (t) => (t.status === 'idle' ? t : { ...t, stale: true }))
    }
    await Promise.all([refreshChannels().catch(() => undefined), current === null ? undefined : catchUp(current), threads.reconnect()])
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
            entries: resetTo(x.entries, prepared(latest.data), meId()),
            hasMoreBefore: latest.has_more,
            stale: false,
            refreshFailed: false,
          }
        }
        const repaired = mergeMessages(x.entries, prepared([...missed.messages, ...latest.data]), meId())
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
    threads.stop()
    reactions.clear()
    uploads.stop()
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
    leave,
    createChannel,
    openConversation,
    refreshChannel,
    reconnect,
    openThread,
    closeThread: (parentId: number) => threads.close(parentId),
    retryThread: (channelId: number, parentId: number) => void threads.load(channelId, parentId),
    loadOlderReplies: (parentId: number) => void threads.loadOlder(parentId),
    toggleReaction: (messageId: number, emoji: string) => reactions.toggle(messageId, emoji),
    editMessage,
    deleteMessage,
    uploads,
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
