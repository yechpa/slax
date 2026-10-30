import { hueStyle } from './hue.ts'
import { PresenceDot, type Presence } from './PresenceDot.tsx'

type Props = {
  name: string
  hue: number
  size?: 'md' | 'sm'
  presence?: Presence
  /** The dot is said by something else nearby (or would be noise, e.g. on every message). */
  presenceHidden?: boolean
}

/** Initial in a tinted square. Decorative: the name is always written next to it. */
export function Avatar({ name, hue, size = 'md', presence, presenceHidden = false }: Props) {
  const initial = [...name.trim()][0] ?? '?'
  return (
    <span class={size === 'sm' ? 'avatar avatar--sm' : 'avatar'} style={hueStyle(hue)}>
      <span aria-hidden="true">{initial}</span>
      {presence && <PresenceDot status={presence} hidden={presenceHidden} />}
    </span>
  )
}
