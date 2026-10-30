/**
 * "X is typing…": client events (whispers) on the channel's private channel.
 *
 * - Outgoing: `client-typing {typing: true, parent_id}` at most once every 3 s while the
 *   user types (Reverb does not rate-limit whispers, so the client must), and one
 *   `{typing: false}` when the message is sent or the field left, if others may still be
 *   showing it.
 * - Incoming: Reverb relays a whisper to the other subscribers only, tagged with the
 *   sender's `user_id` from their signed subscription (a client cannot pretend to be
 *   someone else). Each sender shows for 5 s after their last whisper, per place (the
 *   channel, or a thread). Never me; in a conversation, only its members.
 */
import { computed, signal, type ReadonlySignal } from '@preact/signals'
import type { TypingWhisper } from '../api/types.ts'
import type { EventMeta } from '../realtime/echo.ts'

export const TYPING_THROTTLE_MS = 3000
export const TYPING_EXPIRY_MS = 5000

interface Deps {
  whisper: (channelId: number, data: TypingWhisper) => void
  meId: () => number | null
  /** The members of a conversation (dm, group), or null when not known (rooms). */
  membersOf: (channelId: number) => readonly number[] | null
}

const place = (channelId: number, parentId: number | null) => `${channelId}:${parentId ?? ''}`

export type Typing = ReturnType<typeof createTyping>

export function createTyping({ whisper, meId, membersOf }: Deps) {
  /** When I last whispered "typing" per place. */
  const lastSent = new Map<string, number>()
  /** Who is typing where, until when (epoch ms). */
  const active = signal<ReadonlyMap<string, ReadonlyMap<number, number>>>(new Map())
  const views = new Map<string, ReadonlySignal<number[]>>()
  let timer: ReturnType<typeof setTimeout> | undefined

  function typed(channelId: number, parentId: number | null): void {
    const key = place(channelId, parentId)
    const now = Date.now()
    const last = lastSent.get(key)
    if (last !== undefined && now - last < TYPING_THROTTLE_MS) return
    lastSent.set(key, now)
    whisper(channelId, { typing: true, parent_id: parentId })
  }

  function stopped(channelId: number, parentId: number | null): void {
    const key = place(channelId, parentId)
    const last = lastSent.get(key)
    lastSent.delete(key)
    if (last !== undefined && Date.now() - last < TYPING_EXPIRY_MS) whisper(channelId, { typing: false, parent_id: parentId })
  }

  function received(channelId: number, data: unknown, meta?: EventMeta): void {
    const userId = Number(meta?.user_id)
    if (!Number.isSafeInteger(userId) || userId <= 0 || userId === meId()) return
    const members = membersOf(channelId)
    if (members && !members.includes(userId)) return
    const whispered = data as Partial<TypingWhisper> | null
    if (typeof whispered !== 'object' || whispered === null || typeof whispered.typing !== 'boolean') return
    const parentId = typeof whispered.parent_id === 'number' ? whispered.parent_id : null
    set(place(channelId, parentId), userId, whispered.typing ? Date.now() + TYPING_EXPIRY_MS : null)
  }

  /** Their message arrived: they are done typing there. */
  function noteMessage(channelId: number, userId: number, parentId: number | null): void {
    set(place(channelId, parentId), userId, null)
  }

  function set(key: string, userId: number, until: number | null): void {
    const current = active.peek()
    const here = current.get(key)
    if (until === null && !here?.has(userId)) return
    const nextHere = new Map(here)
    if (until === null) nextHere.delete(userId)
    else nextHere.set(userId, until)
    const next = new Map(current)
    if (nextHere.size === 0) next.delete(key)
    else next.set(key, nextHere)
    active.value = next
    schedule()
  }

  /** One timer, for the next expiry. */
  function schedule(): void {
    clearTimeout(timer)
    let soonest = Infinity
    for (const here of active.peek().values()) for (const until of here.values()) soonest = Math.min(soonest, until)
    if (soonest === Infinity) return
    timer = setTimeout(expire, Math.max(0, soonest - Date.now()))
  }

  function expire(): void {
    const now = Date.now()
    const next = new Map<string, ReadonlyMap<number, number>>()
    for (const [key, here] of active.peek()) {
      const kept = new Map([...here].filter(([, until]) => until > now))
      if (kept.size > 0) next.set(key, kept)
    }
    active.value = next
    schedule()
  }

  /** The ids typing in a channel (parentId null) or a thread, in the order they started. */
  function typers(channelId: number, parentId: number | null): ReadonlySignal<number[]> {
    const key = place(channelId, parentId)
    let view = views.get(key)
    if (!view) {
      view = computed(() => [...(active.value.get(key)?.keys() ?? [])])
      views.set(key, view)
    }
    return view
  }

  function stop(): void {
    clearTimeout(timer)
    lastSent.clear()
    active.value = new Map()
  }

  return { typed, stopped, received, noteMessage, typers, stop }
}
