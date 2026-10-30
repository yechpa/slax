/**
 * The workspace navigation: brand, rooms, direct conversations, and the account menu.
 * Rooms the user has not joined (public ones) are listed muted, tagged "not joined";
 * opening one shows it read-only with a Join button.
 */
import type { Ref } from 'preact'
import type { Channel } from '../api/types.ts'
import { t } from '../i18n/index.ts'
import { channelPath } from '../router.ts'
import { channelsLoaded, conversations, rooms } from '../store/channels.ts'
import { me } from '../store/session.ts'
import { Avatar } from './ui/Avatar.tsx'
import { Brand } from './ui/Brand.tsx'
import { userHue } from './ui/hue.ts'
import { NavItem } from './ui/NavItem.tsx'
import { channelLabel, otherMembers } from './channelNames.ts'
import { UserMenu } from './UserMenu.tsx'

type Props = {
  currentId: number | null
  /** A link was followed (closes the drawer on small screens). */
  onNavigate?: () => void
  navRef?: Ref<HTMLElement>
}

export const SIDEBAR_ID = 'app-sidebar'

export function Sidebar({ currentId, onNavigate, navRef }: Props) {
  const meId = me.value?.id ?? null
  const roomList = rooms.value
  const directList = conversations.value
  return (
    <nav class="sidebar" id={SIDEBAR_ID} aria-label={t('nav.label')} ref={navRef} tabIndex={-1}>
      <p class="sidebar__brand">
        <Brand />
      </p>
      <div class="sidebar__scroll">
        <h2 class="sidebar__heading">
          <span class="sidebar__heading-label">{t('nav.channels')}</span>
        </h2>
        {channelsLoaded.value && roomList.length === 0 && <p class="sidebar__empty">{t('nav.noChannels')}</p>}
        <ul class="sidebar__list">
          {roomList.map((channel) => (
            <li key={channel.id}>
              <NavItem
                name={channel.name ?? ''}
                href={channelPath(channel.id)}
                selected={channel.id === currentId}
                unread={channel.id === currentId ? 0 : channel.unread_count}
                muted={!channel.is_member}
                tag={channel.is_member ? undefined : t('nav.notJoined')}
                leading={channel.kind === 'private' ? <PrivateSigil /> : undefined}
                onClick={onNavigate}
              />
            </li>
          ))}
        </ul>
        <h2 class="sidebar__heading">
          <span class="sidebar__heading-label">{t('nav.directMessages')}</span>
        </h2>
        {channelsLoaded.value && directList.length === 0 && <p class="sidebar__empty">{t('empty.dms')}</p>}
        <ul class="sidebar__list">
          {directList.map((channel) => (
            <li key={channel.id}>
              <NavItem
                name={channelLabel(channel, meId)}
                href={channelPath(channel.id)}
                selected={channel.id === currentId}
                unread={channel.id === currentId ? 0 : channel.unread_count}
                leading={<ConversationAvatar channel={channel} meId={meId} />}
                onClick={onNavigate}
              />
            </li>
          ))}
        </ul>
      </div>
      <UserMenu />
    </nav>
  )
}

/** A private room: a small padlock drawn in CSS, one character wide like the "#" it replaces. */
function PrivateSigil() {
  return <span class="nav-item__sigil nav-item__sigil--private" role="img" aria-label={t('channel.private')} title={t('channel.private')} />
}

function ConversationAvatar({ channel, meId }: { channel: Channel; meId: number | null }) {
  const others = otherMembers(channel, meId)
  const first = others[0]
  if (!first) return null
  return (
    <span class={others.length > 1 ? 'nav-item__avatar nav-item__avatar--group' : 'nav-item__avatar'}>
      <Avatar name={first.name} hue={userHue(String(first.id))} size="sm" />
    </span>
  )
}
