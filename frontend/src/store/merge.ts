/**
 * Pure functions over a timeline's entries: the server's messages in id order, then the
 * messages still on their way (optimistic, keyed by client_id) in the order they were
 * written. Every function returns the same array when nothing changed, so merging the
 * same data twice is a no-op (idempotent) and the UI does not re-render for nothing.
 *
 * Messages come from three places that may overlap or arrive in any order: REST pages,
 * the POST response, and realtime events. The rules that make that safe:
 * - one entry per message id, always sorted by id;
 * - a server message carrying one of my pending client_ids replaces that pending entry
 *   (whichever arrives first, the response or the event, wins; the other is a no-op);
 * - a tombstone is final, and an edit is never rolled back by an older snapshot.
 */
import type { Message } from '../api/types.ts'

export interface ServerEntry {
  kind: 'server'
  key: string
  message: Message
}

export interface PendingEntry {
  kind: 'pending'
  key: string
  /** Lower-case UUID, as the server stores it. Reused as is by a retry. */
  clientId: string
  channelId: number
  parentId: number | null
  body: string
  createdAt: string
  status: 'sending' | 'failed'
  /** ApiError code of the last failure. */
  error: string | null
}

export type Entry = ServerEntry | PendingEntry

export const serverKey = (id: number) => `m:${id}`

export function pendingEntry(channelId: number, clientId: string, body: string, createdAt: string, parentId: number | null = null): PendingEntry {
  return {
    kind: 'pending',
    key: `p:${clientId.toLowerCase()}`,
    clientId: clientId.toLowerCase(),
    channelId,
    parentId,
    body,
    createdAt,
    status: 'sending',
    error: null,
  }
}

/** Merges server messages into the entries (see the rules above). */
export function mergeMessages(entries: readonly Entry[], incoming: readonly Message[], meId: number | null): Entry[] {
  if (incoming.length === 0) return entries as Entry[]
  const servers = new Map<number, ServerEntry>()
  const pending: PendingEntry[] = []
  for (const entry of entries) {
    if (entry.kind === 'server') servers.set(entry.message.id, entry)
    else pending.push(entry)
  }

  let changed = false
  const confirmed = new Set<string>()
  for (const message of incoming) {
    if (!message.deleted && (meId === null || message.user.id === meId)) confirmed.add(message.client_id.toLowerCase())
    const existing = servers.get(message.id)
    const chosen = existing ? fresher(existing.message, message) : message
    if (existing?.message === chosen) continue
    servers.set(message.id, { kind: 'server', key: serverKey(message.id), message: chosen })
    changed = true
  }
  const stillPending = pending.filter((entry) => !confirmed.has(entry.clientId))
  if (stillPending.length !== pending.length) changed = true
  if (!changed) return entries as Entry[]

  const ordered = [...servers.values()].sort((a, b) => a.message.id - b.message.id)
  return [...ordered, ...stillPending]
}

/**
 * Which of two snapshots of the same message to keep. Tombstones are final; between two
 * live copies, an older edit never replaces a newer one; identical content keeps the
 * current object (so a repeated merge changes nothing).
 */
export function fresher(current: Message, incoming: Message): Message {
  if (current.deleted && !incoming.deleted) return current
  if (!current.deleted && !incoming.deleted) {
    const currentEdit = current.edited_at ? Date.parse(current.edited_at) : 0
    const incomingEdit = incoming.edited_at ? Date.parse(incoming.edited_at) : 0
    if (incomingEdit < currentEdit) return current
  }
  return sameContent(current, incoming) ? current : incoming
}

const sameContent = (a: Message, b: Message) => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * A fresh latest page replaces the server window (a gap may separate it from what was
 * loaded). Messages newer than the page (realtime events received meanwhile) and pending
 * ones stay, and a message in both goes through `fresher`: a deletion or an edit applied
 * while the page was on its way is never undone by the page's older snapshot.
 */
export function resetTo(entries: readonly Entry[], page: readonly Message[], meId: number | null): Entry[] {
  const newest = page.reduce((max, message) => Math.max(max, message.id), 0)
  const inPage = new Set(page.map((message) => message.id))
  const kept = entries.filter((entry) => entry.kind === 'pending' || entry.message.id > newest || inPage.has(entry.message.id))
  return mergeMessages(kept, page, meId)
}

export function addPending(entries: readonly Entry[], entry: PendingEntry): Entry[] {
  if (entries.some((e) => e.kind === 'pending' && e.clientId === entry.clientId)) return entries as Entry[]
  return [...entries, entry]
}

export function updatePending(entries: readonly Entry[], clientId: string, patch: Partial<Pick<PendingEntry, 'status' | 'error'>>): Entry[] {
  let changed = false
  const next = entries.map((entry) => {
    if (entry.kind !== 'pending' || entry.clientId !== clientId) return entry
    changed = true
    return { ...entry, ...patch }
  })
  return changed ? next : (entries as Entry[])
}

export function removePending(entries: readonly Entry[], clientId: string): Entry[] {
  const next = entries.filter((entry) => entry.kind !== 'pending' || entry.clientId !== clientId)
  return next.length === entries.length ? (entries as Entry[]) : next
}

export const findPending = (entries: readonly Entry[], clientId: string) =>
  entries.find((entry): entry is PendingEntry => entry.kind === 'pending' && entry.clientId === clientId)

/** Newest message id the server has given us (0 when none). */
export function newestId(entries: readonly Entry[]): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry.kind === 'server') return entry.message.id
  }
  return 0
}

export function oldestId(entries: readonly Entry[]): number | null {
  const first = entries[0]
  return first?.kind === 'server' ? first.message.id : null
}
