/**
 * Reactions: toggled optimistically, with a rollback when the server refuses.
 *
 * What "mine" means for each emoji comes from three sources:
 * - REST answers say `reacted_by_me` for the caller: they are the truth;
 * - broadcasts say `reacted_by_me: false` for everybody (one payload for all members), so
 *   it is derived from `user_ids`, which lists the first 50 reactors only. Beyond them, a
 *   broadcast cannot tell, and what we knew is kept (chat.ts, fromBroadcast);
 * - my own toggles still on their way: they are laid over every snapshot that arrives
 *   meanwhile (an event caused by someone else must not flip my chip back), until the
 *   request answers. If a snapshot already shows my change (a broadcast caused by my own
 *   request), the toggle is marked confirmed: should the request then fail (a lost
 *   response), the change is kept, not rolled back.
 * - The answer is a snapshot from when the server applied my toggle: if an event came while
 *   it was on its way, that event may be newer (someone else reacted just after) and is kept;
 *   my toggle was laid over it, and its own broadcast follows.
 */
import { isApiError } from '../api/client.ts'
import type { Api } from '../api/endpoints.ts'
import type { Message, Reaction } from '../api/types.ts'
import { t } from '../i18n/index.ts'
import { applyKnown, changedSince, findMessage, liveMark, updateMessage } from './messages.ts'
import { showToast } from './ui.ts'

/** backend MessageResource::MAX_REACTION_USER_IDS */
const LISTED_REACTORS = 50

/** Does this aggregate tell whether `meId` reacted? true/false, or null when the list is truncated. */
export function reactedIn(reaction: Reaction | undefined, meId: number): boolean | null {
  if (!reaction) return false
  if (reaction.user_ids.includes(meId)) return true
  return reaction.count <= reaction.user_ids.length ? false : null
}

/** My reaction with `emoji` added (`on`) or removed, as the server will do it. */
export function withMyReaction(reactions: readonly Reaction[], emoji: string, on: boolean, meId: number): Reaction[] {
  const index = reactions.findIndex((r) => r.emoji === emoji)
  const current = reactions[index]
  if (on) {
    if (!current) return [...reactions, { emoji, count: 1, reacted_by_me: true, user_ids: [meId] }]
    if (current.reacted_by_me) return reactions as Reaction[]
    // The server lists reactors in order: I am listed if the list was complete and not full.
    const listed = current.user_ids.length === current.count && current.user_ids.length < LISTED_REACTORS
    const next = { ...current, count: current.count + 1, reacted_by_me: true, user_ids: listed ? [...current.user_ids, meId] : current.user_ids }
    return reactions.map((r, i) => (i === index ? next : r))
  }
  if (!current || !current.reacted_by_me) return reactions as Reaction[]
  if (current.count <= 1) return reactions.filter((_, i) => i !== index)
  const next = { ...current, count: current.count - 1, reacted_by_me: false, user_ids: current.user_ids.filter((id) => id !== meId) }
  return reactions.map((r, i) => (i === index ? next : r))
}

const opKey = (messageId: number, emoji: string) => `${messageId}\u0000${emoji}`

interface PendingToggle {
  messageId: number
  emoji: string
  on: boolean
  /** A snapshot already showed it done (the server applied it). */
  confirmed: boolean
}

export type Reactions = ReturnType<typeof createReactions>

export function createReactions({ api, meId, alive }: { api: Api; meId: () => number | null; alive: () => () => boolean }) {
  const pending = new Map<string, PendingToggle>()

  /** My toggles still on their way, laid over a snapshot that just arrived. */
  function overlay(message: Message): Message {
    if (message.deleted || pending.size === 0) return message
    const id = meId()
    if (id === null) return message
    let reactions = message.reactions
    for (const toggle of pending.values()) {
      if (toggle.messageId !== message.id) continue
      const reaction = reactions.find((r) => r.emoji === toggle.emoji)
      const known = reactedIn(reaction, id)
      if (known === toggle.on) {
        toggle.confirmed = true
        if (reaction && reaction.reacted_by_me !== toggle.on) reactions = reactions.map((r) => (r === reaction ? { ...r, reacted_by_me: toggle.on } : r))
      } else if (known === null) {
        // Beyond the listed reactors: the count is the server's, the state is mine.
        if (reaction && reaction.reacted_by_me !== toggle.on) reactions = reactions.map((r) => (r === reaction ? { ...r, reacted_by_me: toggle.on } : r))
      } else {
        const normalized = reaction && reaction.reacted_by_me !== known ? reactions.map((r) => (r === reaction ? { ...r, reacted_by_me: known } : r)) : reactions
        reactions = withMyReaction(normalized, toggle.emoji, toggle.on, id)
      }
    }
    return reactions === message.reactions ? message : { ...message, reactions }
  }

  /** Adds or removes my `emoji` on a message. A second click while the first is on its way is ignored. */
  async function toggle(messageId: number, emoji: string): Promise<void> {
    const id = meId()
    const message = findMessage(messageId)
    if (id === null || !message || message.deleted) return
    const key = opKey(messageId, emoji)
    if (pending.has(key)) return
    const on = !(message.reactions.find((r) => r.emoji === emoji)?.reacted_by_me ?? false)
    const op: PendingToggle = { messageId, emoji, on, confirmed: false }
    pending.set(key, op)
    const still = alive()
    const mark = liveMark()
    updateMessage(messageId, (m) => (m.deleted ? m : { ...m, reactions: withMyReaction(m.reactions, emoji, on, id) }))
    try {
      const answer = await (on ? api.react(messageId, emoji) : api.unreact(messageId, emoji))
      pending.delete(key)
      if (still() && !changedSince(messageId, mark)) applyKnown(overlay(answer))
    } catch (error) {
      pending.delete(key)
      if (!still() || op.confirmed) return
      updateMessage(messageId, (m) => (m.deleted ? m : { ...m, reactions: withMyReaction(m.reactions, emoji, !on, id) }))
      // A deleted message, a 429 (its own toast): nothing more to say.
      if (isApiError(error, 'rate_limited') || isApiError(error, 'not_found')) return
      const tooMany = isApiError(error, 'validation') && on && error.fields.emoji !== undefined
      showToast({ tone: 'error', text: t(tooMany ? 'error.reactionLimit' : 'error.reactFailed'), key: 'reaction' })
    }
  }

  return { toggle, overlay, clear: () => pending.clear() }
}
