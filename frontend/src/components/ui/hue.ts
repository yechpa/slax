/** Stable colour slot (1-6, see --user-N tokens) for a user, from their id or handle. */
export function userHue(seed: string): number {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return (hash % 6) + 1
}

export const hueStyle = (hue: number) => ({ '--hue': `var(--user-${hue})` })
