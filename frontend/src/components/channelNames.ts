import type { Channel, UserSummary } from '../api/types.ts'

/** The other people of a conversation (all of them if, oddly, only the viewer is left). */
export function otherMembers(channel: Channel, meId: number | null): UserSummary[] {
  const members = channel.members ?? []
  const others = members.filter((m) => m.id !== meId)
  return others.length > 0 ? others : members
}

/** "#general" for a room, "dana, noam" for a conversation: what the list and composer say. */
export function channelLabel(channel: Channel, meId: number | null): string {
  if (channel.kind === 'public' || channel.kind === 'private') return `#${channel.name ?? ''}`
  // Each name isolated (FSI…PDI, the plain-text <bdi>): "dana, נעם" keeps its order in any UI direction.
  return otherMembers(channel, meId)
    .map((m) => `\u2068${m.name}\u2069`)
    .join(', ')
}
