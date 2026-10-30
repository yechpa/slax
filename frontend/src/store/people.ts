/**
 * Who is who: the names of the people the app has heard of (presence channel members,
 * search results, member lists), so an id alone (a typing whisper carries only the
 * sender's id, tagged by the server) can be shown as a name.
 */
import { signal } from '@preact/signals'
import type { UserSummary } from '../api/types.ts'
import { conversations } from './channels.ts'
import { peekTimeline, timelineKeys } from './messages.ts'

const known = signal<ReadonlyMap<number, UserSummary>>(new Map())

export function rememberPeople(people: readonly UserSummary[]): void {
  const current = known.peek()
  if (people.every((p) => p.name === '' || current.get(p.id)?.name === p.name)) return
  const next = new Map(current)
  for (const person of people) if (person.name !== '') next.set(person.id, { id: person.id, name: person.name, avatar_url: person.avatar_url })
  known.value = next
}

/** The person's name, from anything we know about them; null when nobody told us. */
export function personName(id: number): string | null {
  const person = known.value.get(id)
  if (person) return person.name
  for (const channel of conversations.peek()) {
    const member = channel.members?.find((m) => m.id === id)
    if (member) return member.name
  }
  for (const key of timelineKeys()) {
    for (const entry of peekTimeline(key)?.entries ?? []) {
      if (entry.kind === 'server' && !entry.message.deleted && entry.message.user.id === id) return entry.message.user.name
    }
  }
  return null
}

export function resetPeople(): void {
  known.value = new Map()
}
