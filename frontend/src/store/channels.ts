/**
 * The sidebar's channels and conversations, with the caller's unread counts and read
 * pointers. The server's list is the truth, except that a read pointer never moves back:
 * a list fetched before one of our own POST /read calls landed must not resurrect a badge.
 */
import { computed, signal } from '@preact/signals'
import type { Channel, Me } from '../api/types.ts'

export const channels = signal<Channel[]>([])
/** False until the first GET /channels answered. */
export const channelsLoaded = signal(false)

export const channelById = computed(() => new Map(channels.value.map((c) => [c.id, c])))
/** Public and private rooms, in the server's order (by name). */
export const rooms = computed(() => channels.value.filter((c) => c.kind === 'public' || c.kind === 'private'))
/** Direct conversations (dm, group_dm). */
export const conversations = computed(() => channels.value.filter((c) => c.kind === 'dm' || c.kind === 'group_dm'))

export const isDirect = (channel: Channel) => channel.kind === 'dm' || channel.kind === 'group_dm'

/**
 * May post, react and edit there: members, except in a channel an administrator locked,
 * where only administrators still do. The server decides in the end (403 `channel_locked`).
 */
export const canPostIn = (channel: Channel, user: Me | null) => channel.is_member && (!channel.locked || user?.is_admin === true)

/** A member reading a locked channel, who cannot write in it. */
export const lockedFor = (channel: Channel, user: Me | null) => channel.is_member && !canPostIn(channel, user)

export function setChannels(list: Channel[]): void {
  const previous = channelById.peek()
  channels.value = list.map((incoming) => {
    const local = previous.get(incoming.id)
    const localPointer = local?.last_read_message_id ?? null
    const serverPointer = incoming.last_read_message_id
    if (localPointer !== null && (serverPointer === null || localPointer > serverPointer)) {
      return { ...incoming, last_read_message_id: localPointer, unread_count: local?.unread_count ?? 0 }
    }
    return incoming
  })
  channelsLoaded.value = true
}

export function upsertChannel(channel: Channel): void {
  const list = channels.peek()
  const index = list.findIndex((c) => c.id === channel.id)
  if (index === -1) {
    setChannels([...list, channel])
    return
  }
  const next = [...list]
  next[index] = channel
  channels.value = next
}

function patch(id: number, change: (channel: Channel) => Channel): void {
  const list = channels.peek()
  const index = list.findIndex((c) => c.id === id)
  if (index === -1) return
  const updated = change(list[index])
  if (updated === list[index]) return
  const next = [...list]
  next[index] = updated
  channels.value = next
}

export function setUnread(id: number, count: number): void {
  patch(id, (c) => (c.unread_count === count ? c : { ...c, unread_count: count }))
}

export function bumpUnread(id: number): void {
  patch(id, (c) => ({ ...c, unread_count: c.unread_count + 1 }))
}

/** We have read up to `messageId`: the pointer moves forward only, and nothing is unread. */
export function markReadLocally(id: number, messageId: number): void {
  patch(id, (c) =>
    c.last_read_message_id !== null && c.last_read_message_id >= messageId && c.unread_count === 0
      ? c
      : { ...c, last_read_message_id: Math.max(messageId, c.last_read_message_id ?? 0), unread_count: 0 },
  )
}

export function resetChannels(): void {
  channels.value = []
  channelsLoaded.value = false
}
