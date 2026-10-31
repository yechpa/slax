import { t } from '../../i18n/index.ts'

export type Presence = 'online' | 'away' | 'offline'

/**
 * Filled (online), half (away) or hollow (offline): shape and colour, never colour alone.
 * `hidden`: decorative (the state is said elsewhere, or would be repeated on every row).
 */
export function PresenceDot({ status, labelled = false, hidden = false }: { status: Presence; labelled?: boolean; hidden?: boolean }) {
  const label = t(`presence.${status}`)
  if (hidden) return <span class={`presence presence--${status}`} aria-hidden="true" title={label} />
  const dot = <span class={`presence presence--${status}`} role="img" aria-label={label} title={label} />
  if (!labelled) return dot
  return (
    <span class="presence-label">
      <span class={`presence presence--${status}`} aria-hidden="true" />
      {label}
    </span>
  )
}
