/**
 * Threads: one timeline per parent message (`t:{parentId}`, its replies ascending, with
 * the parent alongside), and the thread summary of each parent (`reply_count`,
 * `last_reply_at`) kept up to date where the parent is shown.
 *
 * - Loading follows the channel timeline's rules: the latest page of replies replaces the
 *   window; reply events arriving meanwhile are held and merged after it, so none is lost
 *   and none is undone by the page.
 * - The server does not push the parent's summary when a reply comes or goes, so it is
 *   recomputed here from the replies' own events: a new reply counts once (a repeated
 *   event, or my POST answer plus its event, never twice), a deleted one is taken off once.
 *   When the whole thread is loaded, the summary is simply recounted from it. Events held
 *   during a channel page load count only when newer than the page's own summary.
 *   Known limit: removing the latest reply of a thread that is not loaded keeps the old
 *   "last reply" time until the next refresh (the previous reply's time is not known).
 * - After a reconnection the open thread is refetched; the others are stale until opened.
 * - A summary moved by a reply is a live change: a page asked for before it gets that move laid
 *   over its own summary, never the other way round (see liveMark in messages.ts).
 */
import { isApiError } from '../api/client.ts'
import type { Api } from '../api/endpoints.ts'
import type { Message } from '../api/types.ts'
import { fresher, mergeMessages, oldestId, resetTo } from './merge.ts'
import {
  liveMark,
  noteSummaryChange,
  notOlderThanStore,
  peekTimeline,
  threadKey,
  timelineKeys,
  updateMessage,
  updateTimeline,
  withSummaryDelta,
  type Timeline,
} from './messages.ts'

export const REPLIES_PAGE = 50
/** Reply ids whose effect on their parent's summary is applied (bounded). */
const SEEN_LIMIT = 5000

export type ReplyEvent = 'message.created' | 'message.updated' | 'message.deleted' | 'reaction.changed'

interface Deps {
  api: Api
  meId: () => number | null
  /** A check that turns false once the session stopped (sign-out). */
  alive: () => () => boolean
  /** Lays my reactions still on their way over a snapshot from the server. */
  prepare: (message: Message) => Message
}

export type Threads = ReturnType<typeof createThreads>

const withEntries = (t: Timeline, entries: Timeline['entries']): Timeline => (entries === t.entries ? t : { ...t, entries })

export function createThreads({ api, meId, alive, prepare }: Deps) {
  const loads = new Map<number, AbortController>()
  const held = new Map<number, Message[]>()
  const seen = new Map<number, 'live' | 'deleted'>()
  /** Which channel each loaded thread belongs to (to check the parent's). */
  const channelOf = new Map<number, number>()
  let current: number | null = null

  function remember(id: number, state: 'live' | 'deleted'): void {
    seen.delete(id)
    seen.set(id, state)
    if (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value!)
  }

  /** Shows a thread: loads it unless already loaded and fresh. Its parent shows at once if we have it. */
  function open(channelId: number, parentId: number, known?: Message): void {
    current = parentId
    channelOf.set(parentId, channelId)
    const key = threadKey(parentId)
    if (known && !peekTimeline(key)?.parent) updateTimeline(key, (t) => ({ ...t, parent: known }))
    const t = peekTimeline(key)
    if (!t || t.status === 'idle' || t.status === 'error' || t.stale) void load(channelId, parentId)
  }

  function close(parentId: number): void {
    if (current === parentId) current = null
  }

  async function load(channelId: number, parentId: number): Promise<void> {
    const key = threadKey(parentId)
    const still = alive()
    const mark = liveMark()
    loads.get(parentId)?.abort()
    const controller = new AbortController()
    loads.set(parentId, controller)
    if (!held.has(parentId)) held.set(parentId, [])
    updateTimeline(key, (t) => (t.status === 'ready' ? t : { ...t, status: 'loading', missing: false }))
    try {
      const page = await api.replies(parentId, { limit: REPLIES_PAGE }, controller.signal)
      if (!still()) return
      const events = takeHeld(parentId)
      if (page.parent.channel_id !== channelId || page.parent.parent_id !== null) {
        updateTimeline(key, (t) => ({ ...t, status: 'error', missing: true, entries: [], parent: null }))
        return
      }
      for (const reply of page.data) remember(reply.id, reply.deleted ? 'deleted' : 'live')
      const parent = prepare(notOlderThanStore(page.parent, mark))
      const replies = page.data.map((reply) => prepare(notOlderThanStore(reply, mark)))
      updateTimeline(key, (t) => ({
        ...t,
        parent: t.parent ? fresher(t.parent, parent) : parent,
        entries: mergeMessages(resetTo(t.entries, replies, meId()), events, meId()),
        hasMoreBefore: page.has_more,
        status: 'ready',
        stale: false,
        missing: false,
        refreshFailed: false,
      }))
      recount(parentId)
    } catch (error) {
      if (isApiError(error, 'aborted') || !still()) return
      const events = takeHeld(parentId)
      if (isApiError(error, 'not_found')) {
        updateTimeline(key, (t) => ({ ...t, status: 'error', missing: true, entries: [] }))
        return
      }
      updateTimeline(key, (t) =>
        t.status === 'ready' ? (t.stale ? t : withEntries(t, mergeMessages(t.entries, events, meId()))) : { ...t, status: 'error' },
      )
    } finally {
      if (loads.get(parentId) === controller) loads.delete(parentId)
    }
  }

  function takeHeld(parentId: number): Message[] {
    const events = held.get(parentId) ?? []
    held.delete(parentId)
    return events
  }

  async function loadOlder(parentId: number): Promise<void> {
    const key = threadKey(parentId)
    const t = peekTimeline(key)
    const before = t ? oldestId(t.entries) : null
    if (!t || t.status !== 'ready' || t.loadingOlder || !t.hasMoreBefore || before === null) return
    const still = alive()
    const mark = liveMark()
    updateTimeline(key, (x) => ({ ...x, loadingOlder: true, olderFailed: false }))
    try {
      const page = await api.replies(parentId, { before, limit: REPLIES_PAGE })
      if (!still()) return
      for (const reply of page.data) remember(reply.id, reply.deleted ? 'deleted' : 'live')
      updateTimeline(key, (x) => ({
        ...x,
        entries: mergeMessages(
          x.entries,
          page.data.map((reply) => prepare(notOlderThanStore(reply, mark))),
          meId(),
        ),
        hasMoreBefore: page.has_more,
        loadingOlder: false,
      }))
      recount(parentId)
    } catch {
      if (still()) updateTimeline(key, (x) => ({ ...x, loadingOlder: false, olderFailed: true }))
    }
  }

  /** A reply event (or my POST answer): into its thread if loaded (held while it loads). */
  function onReply(reply: Message): void {
    const parentId = reply.parent_id
    if (parentId === null) return
    const key = threadKey(parentId)
    if (loads.has(parentId)) {
      held.get(parentId)?.push(reply)
      return
    }
    const t = peekTimeline(key)
    if (t && t.status === 'ready' && !t.stale) updateTimeline(key, (x) => withEntries(x, mergeMessages(x.entries, [reply], meId())))
  }

  /**
   * The parent's summary after a reply event. `held`: the event arrived while a channel page
   * was loading, and that page's summary may already count it.
   */
  function noteReply(reply: Message, event: ReplyEvent, { held: wasHeld = false } = {}): void {
    const parentId = reply.parent_id
    if (parentId === null) return
    const state = seen.get(reply.id)
    let delta = 0
    if (event === 'message.created' && !reply.deleted && state === undefined) {
      remember(reply.id, 'live')
      const parent = parentSnapshot(parentId)
      const counted = wasHeld && parent?.last_reply_at != null && Date.parse(reply.created_at) <= Date.parse(parent.last_reply_at)
      delta = counted ? 0 : 1
    } else if (event === 'message.deleted' && state !== 'deleted') {
      remember(reply.id, 'deleted')
      delta = wasHeld ? 0 : -1
    }
    if (delta !== 0) {
      noteSummaryChange(parentId, delta, reply.created_at)
      updateMessage(parentId, (m) => withSummaryDelta(m, delta, reply.created_at))
    }
    recount(parentId)
  }

  function parentSnapshot(parentId: number): Message | undefined {
    for (const key of timelineKeys()) {
      const t = peekTimeline(key)!
      if (t.parent?.id === parentId) return t.parent
      const entry = t.entries.find((e) => e.kind === 'server' && e.message.id === parentId)
      if (entry?.kind === 'server') return entry.message
    }
    return undefined
  }

  /** The whole thread is loaded and fresh: its summary is simply counted. */
  function recount(parentId: number): void {
    const t = peekTimeline(threadKey(parentId))
    if (!t || t.status !== 'ready' || t.stale || t.hasMoreBefore) return
    let count = 0
    let last: string | null = null
    for (const entry of t.entries) {
      if (entry.kind !== 'server' || entry.message.deleted) continue
      count += 1
      if (last === null || Date.parse(entry.message.created_at) > Date.parse(last)) last = entry.message.created_at
    }
    updateMessage(parentId, (m) =>
      m.reply_count === count && (m.last_reply_at === last || (m.last_reply_at !== null && last !== null && Date.parse(m.last_reply_at) === Date.parse(last)))
        ? m
        : { ...m, reply_count: count, last_reply_at: last },
    )
  }

  /** A newer snapshot of a parent (edit, deletion, reactions): the thread shows it too. */
  function onParent(message: Message): void {
    const key = threadKey(message.id)
    const t = peekTimeline(key)
    if (!t?.parent) return
    const next = fresher(t.parent, message)
    if (next !== t.parent) updateTimeline(key, (x) => ({ ...x, parent: next }))
  }

  /** After a reconnection: the open thread is refetched, the others become stale. */
  function reconnect(): Promise<void> {
    for (const key of timelineKeys()) {
      if (!key.startsWith('t:') || key === (current === null ? '' : threadKey(current))) continue
      updateTimeline(key, (t) => (t.status === 'idle' ? t : { ...t, stale: true }))
    }
    if (current === null) return Promise.resolve()
    const channelId = channelOf.get(current)
    return channelId === undefined ? Promise.resolve() : load(channelId, current)
  }

  const isOpen = (key: string) => current !== null && key === threadKey(current)

  function stop(): void {
    for (const controller of loads.values()) controller.abort()
    loads.clear()
    held.clear()
    seen.clear()
    channelOf.clear()
    current = null
  }

  return { open, close, load, loadOlder, onReply, noteReply, onParent, reconnect, isOpen, stop }
}
