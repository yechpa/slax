import { t } from '../../i18n/index.ts'

export type Presence = 'online' | 'away' | 'offline'

/** Filled (online), half (away) or hollow (offline): shape and colour, never colour alone. */
export function PresenceDot({ status, labelled = false }: { status: Presence; labelled?: boolean }) {
  const label = t(`presence.${status}`)
  const dot = <span class={`presence presence--${status}`} role="img" aria-label={label} title={label} />
  if (!labelled) return dot
  return (
    <span class="presence-label">
      <span class={`presence presence--${status}`} aria-hidden="true" />
      {label}
    </span>
  )
}
