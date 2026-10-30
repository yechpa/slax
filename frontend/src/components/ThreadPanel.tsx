/**
 * A thread beside its channel (/c/:id/t/:messageId): the parent message (or its
 * tombstone: the replies stay), its replies in order, and a composer that replies.
 *
 * On a wide screen it is a side panel: Escape closes it while focus is inside. On a
 * narrower one it covers the conversation as a modal drawer, treated like the channel
 * drawer: the rest is inert, focus moves in and stays in (Tab cycles), Escape closes,
 * and focus goes back to what opened it.
 */
import { useEffect, useId, useLayoutEffect, useRef } from 'preact/hooks'
import type { Channel } from '../api/types.ts'
import { sameDay } from '../i18n/format.ts'
import { plural, t } from '../i18n/index.ts'
import { canPostIn } from '../store/channels.ts'
import { threadKey, timeline, type Timeline } from '../store/messages.ts'
import { me } from '../store/session.ts'
import { Button } from './ui/Button.tsx'
import { Divider } from './ui/Divider.tsx'
import { EmptyState } from './ui/EmptyState.tsx'
import { ChatComposer, addFiles } from './ChatComposer.tsx'
import { useChat } from './chatContext.ts'
import { DropZone } from './DropZone.tsx'
import { MessageItem, type MessagePlace } from './MessageItem.tsx'
import { Skeleton, buildRows } from './MessageList.tsx'
import { Typing } from './Typing.tsx'
import { useTrackPresence } from './usePresence.ts'

type Props = {
  channel: Channel
  parentId: number
  /** "#general" or the conversation's names. */
  label: string
  /** Covering the conversation (narrow screens): a modal drawer. */
  modal: boolean
  onClose: () => void
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input:not([type="hidden"]):not([hidden]), select, [tabindex]:not([tabindex="-1"])'

export function ThreadPanel({ channel, parentId, label, modal, onClose }: Props) {
  const chat = useChat()
  const thread = timeline(threadKey(parentId)).value
  const panel = useRef<HTMLDivElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  const close = useRef(onClose)
  close.current = onClose
  const canPost = canPostIn(channel, me.value)
  const place: MessagePlace = { channelId: channel.id, canPost, inThread: true }

  useEffect(() => {
    chat.openThread(channel.id, parentId)
    return () => chat.closeThread(parentId)
  }, [chat, channel.id, parentId])

  // In, and back out to what opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    if (!panel.current?.contains(document.activeElement) || modal) title.current?.focus({ preventScroll: true })
    return () => {
      if (opener?.isConnected && !panel.current?.contains(opener)) opener.focus({ preventScroll: true })
    }
    // Once per thread opened; `modal` only decides the first focus.
  }, [parentId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (!modal && !panel.current?.contains(document.activeElement)) return
      event.preventDefault()
      close.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modal])

  /** Modal: Tab from the last element goes to the first, Shift+Tab from the first to the last. */
  const onKeyDown = (event: KeyboardEvent) => {
    if (!modal || event.key !== 'Tab' || !panel.current) return
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[inert]'))
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === title.current || !panel.current.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !panel.current.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  const content = (
    <>
      <header class="thread__header">
        <h2 class="thread__title" id={titleId} tabIndex={-1} ref={title}>
          {t('thread.title')}
          <span class="thread__where">{t('thread.in', { channel: label })}</span>
        </h2>
        <Button variant="quiet" size="sm" icon class="thread__close" aria-label={t('thread.close')} title={t('thread.close')} onClick={() => close.current()}>
          ×
        </Button>
      </header>
      <ThreadLog thread={thread} place={place} onRetry={() => chat.retryThread(channel.id, parentId)} onOlder={() => chat.loadOlderReplies(parentId)} />
      {canPost && !thread.missing && (
        <footer class="thread__footer">
          <Typing channelId={channel.id} parentId={parentId} />
          <ChatComposer channel={channel} label={label} parentId={parentId} />
        </footer>
      )}
    </>
  )

  return (
    // A div: an <aside> may not be a dialog (ARIA in HTML), and the drawer is one.
    <div
      ref={panel}
      class={modal ? 'thread thread--modal' : 'thread'}
      role={modal ? 'dialog' : 'complementary'}
      aria-modal={modal || undefined}
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      {canPost ? <DropZone onFiles={(files) => addFiles(chat, channel.id, parentId, files)}>{content}</DropZone> : content}
    </div>
  )
}

const firstSameDay = (entries: Timeline['entries'], parentAt: string) => {
  const first = entries[0]
  if (!first) return false
  return sameDay(new Date(first.kind === 'pending' ? first.createdAt : first.message.created_at), new Date(parentAt))
}

/** The parent, then the replies; scrolled to the newest, and kept there while new ones come. */
function ThreadLog({ thread, place, onRetry, onOlder }: { thread: Timeline; place: MessagePlace; onRetry: () => void; onOlder: () => void }) {
  const chat = useChat()
  const meId = me.value?.id ?? null
  const list = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const { parent, entries, status, missing, hasMoreBefore, loadingOlder, olderFailed } = thread
  useTrackPresence(
    `thread:${parent?.id ?? 0}`,
    entries.flatMap((e) => (e.kind === 'server' && !e.message.deleted ? [e.message.user.id] : [])),
  )

  useLayoutEffect(() => {
    const el = list.current
    const last = entries.at(-1)
    const mine = last?.kind === 'pending' || (last?.kind === 'server' && !last.message.deleted && last.message.user.id === meId)
    if (el && (atBottom.current || mine)) el.scrollTop = el.scrollHeight
  }, [entries, parent, status, meId])

  let body
  if (missing) body = <EmptyState>{t('thread.missing')}</EmptyState>
  else if (status === 'error' && !parent) {
    body = (
      <EmptyState>
        {t('thread.loadError')}{' '}
        <Button variant="quiet" size="sm" onClick={onRetry}>
          {t('action.retry')}
        </Button>
      </EmptyState>
    )
  } else if (!parent) body = <Skeleton />
  else {
    const count = parent.reply_count
    body = (
      <>
        <div class="thread__parent">
          <MessageItem entry={{ kind: 'server', key: `m:${parent.id}`, message: parent }} place={place} />
        </div>
        <Divider label={count > 0 ? plural('thread.replyCount', count) : t('thread.noReplies')} />
        {hasMoreBefore &&
          (olderFailed ? (
            <p class="message-list__edge message-list__edge--failed">
              {t('thread.earlierFailed')}{' '}
              <Button variant="quiet" size="sm" onClick={onOlder}>
                {t('action.retry')}
              </Button>
            </p>
          ) : (
            <p class="message-list__edge">
              <Button variant="quiet" size="sm" onClick={onOlder} disabled={loadingOlder}>
                {loadingOlder ? t('message.loadingOlder') : t('thread.earlier')}
              </Button>
            </p>
          ))}
        {status === 'loading' && entries.length === 0 && <Skeleton />}
        {status === 'error' && (
          <p class="message-list__edge message-list__edge--failed">
            {t('thread.loadError')}{' '}
            <Button variant="quiet" size="sm" onClick={onRetry}>
              {t('action.retry')}
            </Button>
          </p>
        )}
        {status === 'ready' && entries.length === 0 && <p class="thread__empty">{t('thread.empty')}</p>}
        {buildRows(entries, meId, null)
          // The parent's day is already said above the replies: no second rule for the same day.
          .filter((row, index) => !(index === 0 && row.kind === 'day' && firstSameDay(entries, parent.created_at)))
          .map((row) =>
          row.kind === 'entry' ? (
            <div key={row.key} class="message-list__row">
              <MessageItem
                entry={row.entry}
                compact={row.compact}
                place={place}
                onRetry={(clientId) => chat.retry(place.channelId, clientId, parent.id)}
                onDiscard={(clientId) => chat.discard(place.channelId, clientId, parent.id)}
              />
            </div>
          ) : row.kind === 'day' ? (
            <Divider key={row.key} label={row.label} />
          ) : null,
        )}
      </>
    )
  }

  return (
    <div
      ref={list}
      class="thread__log"
      role="log"
      tabIndex={0}
      aria-label={t('thread.list')}
      aria-busy={status === 'loading' || loadingOlder}
      onScroll={() => {
        const el = list.current
        if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48
      }}
    >
      {body}
    </div>
  )
}
