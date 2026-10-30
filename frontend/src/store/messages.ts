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

export function resetTimelines(): void {
  timelines.clear()
}
