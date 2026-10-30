import { hueStyle } from './hue.ts'
import { PresenceDot, type Presence } from './PresenceDot.tsx'

type Props = {
  name: string
  hue: number
  size?: 'md' | 'sm'
  presence?: Presence
}

/** Initial in a tinted square. Decorative: the name is always written next to it. */
export function Avatar({ name, hue, size = 'md', presence }: Props) {
  const initial = [...name.trim()][0] ?? '?'
  return (
    <span class={size === 'sm' ? 'avatar avatar--sm' : 'avatar'} style={hueStyle(hue)}>
      <span aria-hidden="true">{initial}</span>
      {presence && <PresenceDot status={presence} />}
    </span>
  )
}
