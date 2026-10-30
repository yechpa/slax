/**
 * One timeline entry: a message (with its files, reactions, thread link and actions), a
 * tombstone (its thread stays reachable), or one of my messages still on its way.
 */
import type { ComponentChildren } from 'preact'
import { useContext, useRef, useState } from 'preact/hooks'
import { isApiError } from '../api/client.ts'
import type { LiveMessage, Message as ApiMessage } from '../api/types.ts'
import { formatDay, formatTime, sameDay } from '../i18n/format.ts'
import { t } from '../i18n/index.ts'
import { navigate, threadPath } from '../router.ts'
import type { Entry } from '../store/merge.ts'
import { me } from '../store/session.ts'
import { showToast } from '../store/ui.ts'
import { Button } from './ui/Button.tsx'
import { Dialog } from './ui/Dialog.tsx'
import { userHue } from './ui/hue.ts'
import { Message } from './ui/Message.tsx'
import { ThreadLink } from './ui/ThreadLink.tsx'
import { Tombstone } from './ui/Tombstone.tsx'
import { Attachments } from './Attachments.tsx'
import { ChatContext } from './chatContext.ts'
import { MessageActions } from './MessageActions.tsx'
import { MessageEditor } from './MessageEditor.tsx'
import { Reactions } from './Reactions.tsx'
import { RichText } from './RichText.tsx'

export const stamp = (iso: string) => ({ iso, label: formatTime(new Date(iso)) })

/** "10:02" today, else "yesterday" or the date. */
const when = (iso: string, now = new Date()) => (sameDay(new Date(iso), now) ? formatTime(new Date(iso)) : formatDay(new Date(iso), now))

/** Where the message is shown. Without it (design samples, tests), it is read-only. */
export type MessagePlace = {
  channelId: number
  /** A member: may react, reply, edit their own. */
  canPost: boolean
  /** In a thread panel: no thread link, no reply action. */
  inThread: boolean
}

type Props = {
  entry: Entry
  /** Same author, a moment after the previous message: no avatar or header. */
  compact?: boolean
  place?: MessagePlace
  onRetry?: (clientId: string) => void
  onDiscard?: (clientId: string) => void
}

export function MessageItem({ entry, compact = false, place, onRetry, onDiscard }: Props) {
  if (entry.kind === 'server') return <ServerMessage message={entry.message} compact={compact} place={place} />

  const author = me.value
  const failed = entry.status === 'failed'
  return (
    <Message
      author={author?.name ?? ''}
      hue={userHue(String(author?.id ?? 0))}
      time={stamp(entry.createdAt)}
      compact={compact}
      busy={!failed}
      class={failed ? 'message--failed' : 'message--pending'}
      attachments={entry.files.length > 0 ? <Attachments files={entry.files} /> : undefined}
      footer={
        failed && (
          <>
            <span class="message__error" role="alert">
              {t(entry.error === 'rate_limited' ? 'error.sendRateLimited' : 'error.sendFailed')}
            </span>
            <Button variant="quiet" size="sm" onClick={() => onRetry?.(entry.clientId)}>
              {t('action.retry')}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => onDiscard?.(entry.clientId)}>
              {t('action.discard')}
            </Button>
          </>
        )
      }
    >
      <RichText text={entry.body} />
    </Message>
  )
}

function ServerMessage({ message, compact, place }: { message: ApiMessage; compact: boolean; place?: MessagePlace }) {
  const threadLink =
    place && !place.inThread && message.reply_count > 0 ? (
      <ThreadLink
        href={threadPath(place.channelId, message.id)}
        replies={message.reply_count}
        lastReply={message.last_reply_at ? when(message.last_reply_at) : undefined}
      />
    ) : undefined
  if (message.deleted) return <Tombstone time={stamp(message.created_at)} footer={threadLink} />
  return <LiveItem message={message} compact={compact} place={place} threadLink={threadLink} />
}

function LiveItem({ message, compact, place, threadLink }: { message: LiveMessage; compact: boolean; place?: MessagePlace; threadLink?: ComponentChildren }) {
  const chat = useContext(ChatContext)
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const mine = message.user.id === me.value?.id
  const canPost = place?.canPost ?? false
  const presence = chat?.presence.stateOf(message.user.id)

  /** After the editor or the confirmation: back to the message's own "more" button. */
  const refocus = () => queueMicrotask(() => root.current?.querySelector<HTMLElement>('.message-actions__more')?.focus())

  const remove = async () => {
    if (!chat) return
    // The message turns into a tombstone (this component goes): focus stays in its list.
    const list = root.current?.closest<HTMLElement>('[role="log"]')
    setDeleting(true)
    try {
      await chat.deleteMessage(message.id)
      setConfirming(false)
      list?.focus({ preventScroll: true })
    } catch (error) {
      setDeleting(false)
      setConfirming(false)
      refocus()
      if (!isApiError(error, 'rate_limited')) showToast({ tone: 'error', text: t('error.deleteFailed'), key: 'delete' })
    }
  }

  const actions =
    chat && place ? (
      <MessageActions
        canPost={canPost}
        mine={mine}
        onReply={place.inThread ? undefined : () => navigate(threadPath(place.channelId, message.id))}
        onReact={(emoji) => void chat.toggleReaction(message.id, emoji)}
        onEdit={() => setEditing(true)}
        onDelete={() => setConfirming(true)}
        onOpenChange={setActionsOpen}
      />
    ) : undefined

  const reactions = message.reactions.length > 0 && (
    <Reactions reactions={message.reactions} canReact={canPost && chat !== null} onToggle={(emoji) => void chat?.toggleReaction(message.id, emoji)} />
  )

  return (
    <div class="message-item" ref={root}>
      <Message
        author={message.user.name}
        hue={userHue(String(message.user.id))}
        time={stamp(message.created_at)}
        edited={message.edited_at !== null}
        compact={compact}
        presence={presence}
        // message--menu: on touch screens its "more" button gets a column of its own (chat.css).
        class={actionsOpen || editing ? 'message--menu message--actions-open' : actions ? 'message--menu' : undefined}
        editor={
          editing ? (
            <MessageEditor
              messageId={message.id}
              initial={message.body}
              onDone={() => {
                setEditing(false)
                refocus()
              }}
            />
          ) : undefined
        }
        attachments={message.files.length > 0 ? <Attachments files={message.files} /> : undefined}
        footer={
          (reactions || threadLink) && (
            <>
              {reactions}
              {threadLink}
            </>
          )
        }
        actions={editing ? undefined : actions}
      >
        {message.body !== '' && <RichText text={message.body} />}
      </Message>
      {confirming && (
        <Dialog
          role="alertdialog"
          title={t('message.deleteTitle')}
          description={t('message.deleteBody')}
          onClose={() => {
            if (deleting) return
            setConfirming(false)
            refocus()
          }}
          footer={
            <>
              <Button
                variant="secondary"
                data-autofocus
                onClick={() => {
                  setConfirming(false)
                  refocus()
                }}
                disabled={deleting}
              >
                {t('action.cancel')}
              </Button>
              <Button variant="danger" onClick={() => void remove()} disabled={deleting}>
                {t('action.delete')}
              </Button>
            </>
          }
        />
      )}
    </div>
  )
}
