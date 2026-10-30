/**
 * About a channel or conversation: its topic and its members (with their presence),
 * owners first. An owner of a room can add people and remove members (confirmed first); a
 * member can leave a room (the server refuses when they are its only owner, and that is said).
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { isApiError } from '../api/client.ts'
import { api } from '../api/endpoints.ts'
import type { Channel, ChannelMember, UserSummary } from '../api/types.ts'
import { plural, t } from '../i18n/index.ts'
import { navigate } from '../router.ts'
import { isDirect } from '../store/channels.ts'
import { rememberPeople } from '../store/people.ts'
import { me } from '../store/session.ts'
import { showToast } from '../store/ui.ts'
import { Avatar } from './ui/Avatar.tsx'
import { Button } from './ui/Button.tsx'
import { Dialog } from './ui/Dialog.tsx'
import { userHue } from './ui/hue.ts'
import { useChat } from './chatContext.ts'
import { PeoplePicker } from './PeoplePicker.tsx'
import { useTrackPresence } from './usePresence.ts'

type Props = {
  channel: Channel
  /** "#general" or the conversation's names. */
  label: string
  onClose: () => void
}

type Members = { status: 'loading' } | { status: 'error' } | { status: 'ready'; list: ChannelMember[] }

export function ChannelDetails({ channel, label, onClose }: Props) {
  const chat = useChat()
  const meId = me.value?.id ?? null
  const [members, setMembers] = useState<Members>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)
  /** The member whose removal is being confirmed. */
  const [removing, setRemoving] = useState<ChannelMember | null>(null)
  const membersList = useRef<HTMLUListElement>(null)
  const room = !isDirect(channel)
  const list = members.status === 'ready' ? members.list : []
  const owner = room && list.some((m) => m.id === meId && m.role === 'owner')
  useTrackPresence(`details:${channel.id}`, list.map((m) => m.id))

  const load = async (signal?: AbortSignal) => {
    try {
      const answer = await api.channelMembers(channel.id, signal)
      rememberPeople(answer)
      setMembers({ status: 'ready', list: answer })
    } catch (error) {
      if (!isApiError(error, 'aborted')) setMembers({ status: 'error' })
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [channel.id])

  const add = async (person: UserSummary) => {
    setBusy(true)
    try {
      await api.addMember(channel.id, person.id)
      showToast({ tone: 'success', text: t('details.added', { name: person.name, channel: label }), key: 'members' })
      await Promise.all([load(), chat.refreshChannel(channel.id).catch(() => undefined)])
    } catch (error) {
      if (!isApiError(error, 'rate_limited')) showToast({ tone: 'error', text: t('details.addFailed', { name: person.name }), key: 'members' })
    } finally {
      setBusy(false)
    }
  }

  const cancelRemove = () => {
    if (!busy) setRemoving(null)
  }

  const remove = async (member: ChannelMember) => {
    setBusy(true)
    try {
      await api.removeMember(channel.id, member.id)
      setRemoving(null)
      setMembers((current) => (current.status === 'ready' ? { status: 'ready', list: current.list.filter((m) => m.id !== member.id) } : current))
      void chat.refreshChannel(channel.id).catch(() => undefined)
    } catch (error) {
      setRemoving(null)
      if (!isApiError(error, 'rate_limited')) showToast({ tone: 'error', text: t('details.removeFailed', { name: member.name }), key: 'members' })
    } finally {
      setBusy(false)
    }
  }

  const leave = async () => {
    setBusy(true)
    setLeaveError(null)
    try {
      await chat.leave(channel.id)
      onClose()
      showToast({ tone: 'success', text: t('details.left', { channel: label }), key: 'leave' })
      // A private room is gone from the list: back home. A public one stays, readable.
      if (channel.kind === 'private') navigate('/')
    } catch (error) {
      setBusy(false)
      if (isApiError(error, 'rate_limited')) return
      setLeaveError(t(isApiError(error, 'sole_owner') ? 'details.soleOwner' : 'details.leaveFailed', { channel: label }))
    }
  }

  return (
    <Dialog
      title={room ? t('details.title', { channel: label }) : t('details.conversation')}
      onClose={onClose}
      class="dialog--details"
      footer={
        <>
          {room && channel.is_member && (
            <Button variant="danger" class="details__leave" onClick={() => void leave()} disabled={busy}>
              {t('channel.leave')}
            </Button>
          )}
          <Button variant="secondary" data-autofocus onClick={onClose}>
            {t('action.close')}
          </Button>
        </>
      }
    >
      {room && (
        <section class="details__section">
          <h3 class="details__heading">{t('details.topic')}</h3>
          <p class={channel.topic ? 'details__topic' : 'details__topic details__topic--none'}>{channel.topic ? <bdi>{channel.topic}</bdi> : t('details.noTopic')}</p>
        </section>
      )}
      <section class="details__section">
        <h3 class="details__heading">{plural('channel.members', channel.member_count)}</h3>
        {members.status === 'loading' && <p class="details__note">{t('app.loading')}</p>}
        {members.status === 'error' && (
          <p class="details__note details__note--error">
            {t('details.membersError')}{' '}
            <Button variant="quiet" size="sm" onClick={() => void load()}>
              {t('action.retry')}
            </Button>
          </p>
        )}
        {members.status === 'ready' && (
          <ul class="details__members" ref={membersList} tabIndex={-1}>
            {list.map((member) => (
              <li class="details__member" key={member.id} data-member={member.id}>
                <Avatar name={member.name} hue={userHue(String(member.id))} size="sm" presence={chat.presence.stateOf(member.id)} />
                <bdi class="details__member-name">{member.name}</bdi>
                {member.id === meId && <span class="details__tag">{t('details.you')}</span>}
                {member.role === 'owner' && <span class="details__tag details__tag--owner">{t('details.owner')}</span>}
                {owner && member.id !== meId && (
                  <Button variant="quiet" size="sm" class="details__remove" aria-label={t('details.remove', { name: member.name })} onClick={() => setRemoving(member)} disabled={busy}>
                    {t('action.remove')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {members.status === 'ready' && channel.member_count > list.length && <p class="details__note">{plural('details.more', channel.member_count - list.length)}</p>}
      </section>
      {owner && (
        <section class="details__section">
          <PeoplePicker
            label={t('details.add')}
            placeholder={t('people.placeholder')}
            selected={[]}
            exclude={list.map((m) => m.id)}
            disabled={busy}
            onSelect={(person) => void add(person)}
          />
        </section>
      )}
      {leaveError && (
        <p class="field__error" role="alert">
          {leaveError}
        </p>
      )}
      {removing && (
        <Dialog
          role="alertdialog"
          title={t('details.removeTitle', { name: removing.name, channel: label })}
          description={t('details.removeBody')}
          onClose={cancelRemove}
          // Back to that member's Remove button; once they are removed (the button is gone), to the list.
          returnFocus={() =>
            membersList.current?.querySelector<HTMLElement>(`[data-member="${removing.id}"] .details__remove`) ?? membersList.current
          }
          footer={
            <>
              <Button variant="secondary" data-autofocus onClick={cancelRemove} disabled={busy}>
                {t('action.cancel')}
              </Button>
              <Button variant="danger" onClick={() => void remove(removing)} disabled={busy}>
                {t('action.remove')}
              </Button>
            </>
          }
        />
      )}
    </Dialog>
  )
}
