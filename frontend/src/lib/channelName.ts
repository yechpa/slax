/** Channel names as the server accepts them (backend ChannelController::store). */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

export const CHANNEL_NAME_MAX = 40

export type ChannelNameProblem = 'empty' | 'long' | 'start' | 'chars' | null

/** Why the server would refuse this name, or null when it matches CHANNEL_NAME. */
export function channelNameProblem(name: string): ChannelNameProblem {
  if (CHANNEL_NAME.test(name)) return null
  if (name === '') return 'empty'
  if (!/^[a-z0-9-]*$/.test(name)) return 'chars'
  if (!/^[a-z0-9]/.test(name)) return 'start'
  return 'long'
}

/** While typing: capitals become small letters and spaces dashes; anything else is left for the hint. */
export const normalizeChannelName = (input: string) => input.toLowerCase().replace(/ /g, '-')
