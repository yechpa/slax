import type { ComponentChildren } from 'preact'
import { plural, t } from '../../i18n/index.ts'
import { PresenceDot, type Presence } from './PresenceDot.tsx'

type Props = {
  name: string
  /** Language of the name, when it is not the page's. */
  lang?: string
  href: string
  /** Channels show "#", direct messages show the person's presence. */
  presence?: Presence
  selected?: boolean
  unread?: number
  muted?: boolean
  /** Replaces the "#" sigil (e.g. a small avatar for a conversation). */
  leading?: ComponentChildren
  /** Replaces the "muted" tag of a muted item (e.g. "not joined"). */
  tag?: string
  onClick?: (event: MouseEvent) => void
}

/** Badges stop at 99+; the accessible name keeps the true count. */
export const badgeText = (unread: number) => (unread > 99 ? '99+' : String(unread))

export function NavItem({ name, lang, href, presence, selected = false, unread = 0, muted = false, leading, tag, onClick }: Props) {
  const classes = ['nav-item', unread > 0 && !muted && 'nav-item--unread', muted && 'nav-item--muted']
  return (
    <a class={classes.filter(Boolean).join(' ')} href={href} aria-current={selected ? 'page' : undefined} onClick={onClick}>
      {leading ?? (presence ? (
        <PresenceDot status={presence} />
      ) : (
        <span class="nav-item__sigil" aria-hidden="true">
          #
        </span>
      ))}
      <bdi class="nav-item__label" lang={lang}>
        {name}
      </bdi>
      {muted && <span class="nav-item__tag">{tag ?? t('nav.muted')}</span>}
      {unread > 0 && !muted && (
        <span class="nav-item__badge" role="img" aria-label={plural('nav.unread', unread)}>
          {/* LTR-isolated: "99+" would print "+99" in a right-to-left line. */}
          <bdi dir="ltr" aria-hidden="true">
            {badgeText(unread)}
          </bdi>
        </span>
      )}
    </a>
  )
}
