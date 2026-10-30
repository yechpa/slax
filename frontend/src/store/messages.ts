/**
 * Message timelines, one signal each, keyed by what they list: `c:12` is the timeline of
 * channel 12 (top-level messages). Threads (part B) get their own keys on the same model.
 * Components read `timeline(key).value`; only the chat controller writes.
 */
import { signal, type Signal } from '@preact/signals'
import type { Entry } from './merge.ts'

export interface Timeline {
  entries: Entry[]
  /** Older messages exist on the server (load them with `before`). */
  hasMoreBefore: boolean
  /** idle: never loaded. loading: first page on its way. error: it failed (retry). */
  status: 'idle' | 'loading' | 'ready' | 'error'
  loadingOlder: boolean
  /** Possibly out of date (events were missed while disconnected): refetched when opened. */
  stale: boolean
}

export const emptyTimeline = (): Timeline => ({ entries: [], hasMoreBefore: false, status: 'idle', loadingOlder: false, stale: false })

export const channelKey = (channelId: number) => `c:${channelId}`

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

export function resetTimelines(): void {
  timelines.clear()
}
