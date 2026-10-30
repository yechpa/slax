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
import { openDialog } from '../store/ui.ts'
import { Avatar } from './ui/Avatar.tsx'
import { Brand } from './ui/Brand.tsx'
import { userHue } from './ui/hue.ts'
import { NavItem } from './ui/NavItem.tsx'
import { channelLabel, otherMembers } from './channelNames.ts'
import { useContext } from 'preact/hooks'
import { ChatContext } from './chatContext.ts'
import { useTrackPresence } from './usePresence.ts'
import { UserMenu } from './UserMenu.tsx'

type Props = {
  currentId: number | null
  /** A link was followed (closes the drawer on small screens). */
  onNavigate?: () => void
  navRef?: Ref<HTMLElement>
  /** Behind a modal (the thread drawer). */
  inert?: boolean
}

export const SIDEBAR_ID = 'app-sidebar'

export function Sidebar({ currentId, onNavigate, navRef, inert }: Props) {
  const meId = me.value?.id ?? null
  const roomList = rooms.value
  const directList = conversations.value
  useTrackPresence(
    'sidebar',
    directList.flatMap((channel) => otherMembers(channel, meId).map((m) => m.id)),
  )
  const action = (dialog: NonNullable<typeof openDialog.value>) => () => {
    onNavigate?.()
    openDialog.value = dialog
  }
  return (
    <nav class="sidebar" id={SIDEBAR_ID} aria-label={t('nav.label')} ref={navRef} tabIndex={-1} inert={inert}>
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
          <li>
            <NavAction sigil="+" label={t('nav.newChannel')} onClick={action('create-channel')} />
          </li>
          <li>
            <NavAction sigil=">" label={t('nav.browse')} onClick={action('browse-channels')} />
          </li>
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
          <li>
            <NavAction sigil="+" label={t('nav.newMessage')} onClick={action('new-message')} />
          </li>
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

/** A sidebar row that opens a dialog (new channel, browse, new message). */
function NavAction({ sigil, label, onClick }: { sigil: string; label: string; onClick: () => void }) {
  return (
    <button type="button" class="nav-item nav-item--action" aria-haspopup="dialog" onClick={onClick}>
      <span class="nav-item__sigil" aria-hidden="true">
        {sigil}
      </span>
      <span class="nav-item__label">{label}</span>
    </button>
  )
}

/** The other person's avatar and presence (a group: two squares, no single presence). */
function ConversationAvatar({ channel, meId }: { channel: Channel; meId: number | null }) {
  const chat = useContext(ChatContext)
  const others = otherMembers(channel, meId)
  const first = others[0]
  if (!first) return null
  const group = others.length > 1
  return (
    <span class={group ? 'nav-item__avatar nav-item__avatar--group' : 'nav-item__avatar'}>
      <Avatar name={first.name} hue={userHue(String(first.id))} size="sm" presence={group ? undefined : chat?.presence.stateOf(first.id)} />
    </span>
  )
}
