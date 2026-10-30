/**
 * Message timelines, one signal each, keyed by what they list: `c:12` is the timeline of
 * channel 12 (top-level messages), `t:40` the thread of message 40 (its replies, with the
 * parent alongside). Components read `timeline(key).value`; only the chat controller writes.
 */
import { batch, signal, type Signal } from '@preact/signals'
import type { Message } from '../api/types.ts'
import { fresher, replaceKnown, type Entry } from './merge.ts'

export interface Timeline {
  entries: Entry[]
  /** Older messages exist on the server (load them with `before`). */
  hasMoreBefore: boolean
  /** idle: never loaded. loading: first page on its way. error: it failed (retry). */
  status: 'idle' | 'loading' | 'ready' | 'error'
  loadingOlder: boolean
  /** Possibly out of date (events were missed while disconnected): refetched when opened. */
  stale: boolean
  /** Refreshing after a reconnection keeps failing (it is retried; the view offers a Retry). */
  refreshFailed: boolean
  /** The last older page failed: no more automatic tries until the reader asks. */
  olderFailed: boolean
  /** Threads: the message replied to (a tombstone once deleted), when known. */
  parent: Message | null
  /** Threads: it does not exist (any more), or not in this channel. */
  missing: boolean
}

export const emptyTimeline = (): Timeline => ({
  entries: [],
  hasMoreBefore: false,
  status: 'idle',
  loadingOlder: false,
  stale: false,
  refreshFailed: false,
  olderFailed: false,
  parent: null,
  missing: false,
})

export const channelKey = (channelId: number) => `c:${channelId}`
export const threadKey = (parentId: number) => `t:${parentId}`

const timelines = new Map<string, Signal<Timeline>>()

export function timeline(key: string): Signal<Timeline> {
  let entry = timelines.get(key)
  if (!entry) {
    entry = signal(emptyTimeline())
    timelines.set(key, entry)
  }
  return entry
}

/** The timeline if it was ever created (does not create one). */
export const peekTimeline = (key: string): Timeline | undefined => timelines.get(key)?.peek()

export function updateTimeline(key: string, update: (current: Timeline) => Timeline): void {
  const entry = timeline(key)
  const next = update(entry.peek())
  if (next !== entry.peek()) entry.value = next
}

export const timelineKeys = () => [...timelines.keys()]

/** The latest snapshot we hold of a message (in any timeline, or as a thread's parent). */
export function findMessage(id: number): Message | undefined {
  for (const entry of timelines.values()) {
    const t = entry.peek()
    if (t.parent?.id === id) return t.parent
    for (const e of t.entries) if (e.kind === 'server' && e.message.id === id) return e.message
  }
  return undefined
}

/** Changes a message wherever it is shown (timelines and thread parents); `change` returns it unchanged to skip. */
export function updateMessage(id: number, change: (message: Message) => Message): void {
  batch(() => {
    for (const [key, entry] of timelines) {
      const t = entry.peek()
      const parent = t.parent?.id === id ? change(t.parent) : t.parent
      let entries = t.entries
      const index = entries.findIndex((e) => e.kind === 'server' && e.message.id === id)
      if (index !== -1) {
        const current = (entries[index] as Extract<Entry, { kind: 'server' }>).message
        const next = change(current)
        if (next !== current) {
          entries = [...entries]
          entries[index] = { kind: 'server', key: entries[index].key, message: next }
        }
      }
      if (parent !== t.parent || entries !== t.entries) updateTimeline(key, (x) => ({ ...x, parent, entries }))
    }
  })
}

/** A newer server snapshot of a message (edit, deletion, reactions): applied wherever that message is shown. */
export function applyKnown(message: Message): void {
  batch(() => {
    for (const [key, entry] of timelines) {
      const t = entry.peek()
      const parent = t.parent?.id === message.id ? fresher(t.parent, message) : t.parent
      const entries = replaceKnown(t.entries, message)
      if (parent !== t.parent || entries !== t.entries) updateTimeline(key, (x) => ({ ...x, parent, entries }))
    }
  })
}

/**
 * Live changes against REST answers. A REST answer (a page, the answer to my reaction, edit
 * or post) is a snapshot taken when the server handled the request; a broadcast that arrived
 * while it was on its way may be newer (someone reacted just after), and replacing the
 * event's copy with the answer's would undo it. Live changes are numbered, and a request
 * notes the number when it starts (`liveMark`). Two kinds:
 * - a snapshot (an event carrying the whole message: created, edited, deleted, reactions):
 *   the answer gives way, for that message, to the copy the store holds (`changedSince`);
 * - a thread summary moved by a reply (the server pushes the reply, not its parent): a delta
 *   on whatever copy the store had, possibly stale itself (a catch-up repairs it). The answer
 *   is kept, and the deltas since the request started are laid over it again: a new reply
 *   counts unless the answer's last reply is as recent (it saw it already); a deletion is
 *   assumed seen by the answer (as for events held during a page load, see threads.ts).
 * Nothing is lost by that: every change is broadcast to every member, the requester included,
 * so the answer's own change is in an event that came, or will come. While no event arrives
 * (socket down), answers apply as they are.
 */
let liveClock = 0
const changedAt = new Map<number, number>()
interface SummaryChange {
  clock: number
  delta: number
  /** The reply's creation time. */
  at: string
}
const summaryChanges = new Map<number, SummaryChange[]>()
const CHANGED_LIMIT = 5000
const SUMMARY_CHANGES_KEPT = 100

export const liveMark = (): number => liveClock

/** A live snapshot of message `id` (an event carrying the whole message) arrived. */
export function noteLiveChange(id: number): void {
  liveClock += 1
  changedAt.delete(id)
  changedAt.set(id, liveClock)
  if (changedAt.size > CHANGED_LIMIT) changedAt.delete(changedAt.keys().next().value!)
}

/** A reply created at `at` moved the summary of `parentId` by `delta` (+1 or -1). */
export function noteSummaryChange(parentId: number, delta: number, at: string): void {
  liveClock += 1
  const list = summaryChanges.get(parentId) ?? []
  list.push({ clock: liveClock, delta, at })
  if (list.length > SUMMARY_CHANGES_KEPT) list.shift()
  summaryChanges.delete(parentId)
  summaryChanges.set(parentId, list)
  if (summaryChanges.size > CHANGED_LIMIT) summaryChanges.delete(summaryChanges.keys().next().value!)
}

/** Did a live snapshot of message `id` arrive after `mark` (a request's start)? */
export const changedSince = (id: number, mark: number): boolean => (changedAt.get(id) ?? 0) > mark

/** The summary moved by one reply: +1 (at `at`) or -1. */
export function withSummaryDelta(message: Message, delta: number, at: string): Message {
  const count = Math.max(0, message.reply_count + delta)
  let last = message.last_reply_at
  if (delta > 0 && (last === null || Date.parse(at) > Date.parse(last))) last = at
  if (count === 0) last = null
  return count === message.reply_count && last === message.last_reply_at ? message : { ...message, reply_count: count, last_reply_at: last }
}

/**
 * A message of a REST answer asked for at `mark`: the store's copy when a live snapshot came
 * since; otherwise the answer, with the summary deltas since then laid over it. A tombstone
 * is final, never older than anything: it is always taken as it is.
 */
export function notOlderThanStore(message: Message, mark: number): Message {
  if (message.deleted) return message
  if (changedSince(message.id, mark)) return findMessage(message.id) ?? message
  let result: Message = message
  for (const change of summaryChanges.get(message.id) ?? []) {
    if (change.clock <= mark || change.delta < 0) continue
    // The answer already counts a reply no later than its own last one.
    if (result.last_reply_at !== null && Date.parse(change.at) <= Date.parse(result.last_reply_at)) continue
    result = withSummaryDelta(result, change.delta, change.at)
  }
  return result
}

export function resetTimelines(): void {
  timelines.clear()
  changedAt.clear()
  summaryChanges.clear()
}
