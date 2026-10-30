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
}

export function NavItem({ name, lang, href, presence, selected = false, unread = 0, muted = false }: Props) {
  const classes = ['nav-item', unread > 0 && !muted && 'nav-item--unread', muted && 'nav-item--muted']
  return (
    <a class={classes.filter(Boolean).join(' ')} href={href} aria-current={selected ? 'page' : undefined}>
      {presence ? (
        <PresenceDot status={presence} />
      ) : (
        <span class="nav-item__sigil" aria-hidden="true">
          #
        </span>
      )}
      <bdi class="nav-item__label" lang={lang}>
        {name}
      </bdi>
      {muted && <span class="nav-item__tag">{t('nav.muted')}</span>}
      {unread > 0 && !muted && (
        <span class="nav-item__badge" aria-label={plural('nav.unread', unread)}>
          {unread}
        </span>
      )}
    </a>
  )
}
