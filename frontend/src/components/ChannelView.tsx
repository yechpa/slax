/**
 * One channel or conversation: header, message log and composer (or, for a public
 * channel the user has not joined, a read-only notice with a Join button).
 */
import type { Ref } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { isApiError } from '../api/client.ts'
import type { Channel } from '../api/types.ts'
import { plural, t } from '../i18n/index.ts'
import { writePref } from '../lib/prefs.ts'
import { isDirect } from '../store/channels.ts'
import { channelKey, timeline } from '../store/messages.ts'
import { me } from '../store/session.ts'
import { drafts, showToast } from '../store/ui.ts'
import { Button } from './ui/Button.tsx'
import { ChannelName } from './ui/ChannelName.tsx'
import { charCount, Composer } from './ui/Composer.tsx'
import { TypingIndicator } from './ui/TypingIndicator.tsx'
import { channelLabel } from './channelNames.ts'
import { useChat } from './chatContext.ts'
import { MessageList } from './MessageList.tsx'
import { NavToggle } from './NavToggle.tsx'

export const MAX_BODY = 4000
export const LAST_CHANNEL_KEY = 'slax.lastChannel'

/** Trimmed like the server does: plain whitespace only (bidi marks at the edges are kept). */
const trimBody = (text: string) => text.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, '')

type Props = {
  channel: Channel
  navOpen: boolean
  onToggleNav: () => void
  toggleRef: Ref<HTMLButtonElement>
}

export function ChannelView({ channel, navOpen, onToggleNav, toggleRef }: Props) {
  const chat = useChat()
  const meId = me.value?.id ?? null
  const label = channelLabel(channel, meId)
  const messages = timeline(channelKey(channel.id)).value
  // The "new messages" rule stays where the reading stopped when the channel was opened.
  const [unreadAfter, setUnreadAfter] = useState(() => (channel.unread_count > 0 ? (channel.last_read_message_id ?? 0) : null))

  useEffect(() => {
    chat.openChannel(channel.id)
    writePref(LAST_CHANNEL_KEY, String(channel.id))
    return () => chat.closeChannel(channel.id)
  }, [chat, channel.id])

  useEffect(() => {
    document.title = `${label.replace(/[⁨⁩]/g, '')} · slax`
  }, [label])

  return (
    <>
      <header class="channel-header">
        <NavToggle open={navOpen} onToggle={onToggleNav} buttonRef={toggleRef} />
        <div class="channel-header__title">
          <h2 class="channel-header__name" id="channel-title">
            {isDirect(channel) ? <bdi>{label}</bdi> : <ChannelName name={channel.name ?? ''} />}
          </h2>
          <span class="channel-header__meta">
            {channel.kind === 'private' && <>{t('channel.private')} · </>}
            {plural('channel.members', channel.member_count)}
          </span>
          {channel.topic && (
            // Aligned with the interface; the topic itself is isolated and takes its own direction.
            <span class="channel-header__topic" title={channel.topic}>
              <bdi>{channel.topic}</bdi>
            </span>
          )}
        </div>
      </header>

      <MessageList
        label={label}
        direct={isDirect(channel)}
        timeline={messages}
        meId={meId}
        unreadAfter={unreadAfter}
        onLoadOlder={() => void chat.loadOlder(channel.id)}
        onRetryLoad={() => void chat.loadLatest(channel.id)}
        onRetry={(clientId) => chat.retry(channel.id, clientId)}
        onDiscard={(clientId) => chat.discard(channel.id, clientId)}
        onAtBottom={() => chat.noteReadable(channel.id)}
      />

      <footer class="shell__footer">
        {/* Keeps its line (typing indicators arrive with presence), so the composer never jumps. */}
        <TypingIndicator names={[]} />
        {channel.is_member ? (
          <ChatComposer channel={channel} label={label} onSent={() => setUnreadAfter(null)} />
        ) : (
          <JoinBar channel={channel} label={label} />
        )}
      </footer>
    </>
  )
}

function ChatComposer({ channel, label, onSent }: { channel: Channel; label: string; onSent: () => void }) {
  const chat = useChat()
  const [value, setValue] = useState(() => drafts.get(channel.id) ?? '')
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // Ready to type on a desktop; on a touch screen, opening the keyboard uninvited is rude.
    if (globalThis.matchMedia?.('(pointer: fine)').matches) input.current?.focus({ preventScroll: true })
  }, [channel.id])

  const onInput = (next: string) => {
    setValue(next)
    if (next) drafts.set(channel.id, next)
    else drafts.delete(channel.id)
  }

  const send = () => {
    const body = trimBody(value)
    if (body === '' || charCount(body) > MAX_BODY) return
    chat.send(channel.id, body)
    onInput('')
    onSent()
    input.current?.focus()
  }

  return (
    <Composer
      channel={label}
      placeholder={isDirect(channel) ? t('composer.placeholderDirect', { name: label }) : undefined}
      value={value}
      onInput={onInput}
      onSend={send}
      maxLength={MAX_BODY}
      inputRef={input}
    />
  )
}

function JoinBar({ channel, label }: { channel: Channel; label: string }) {
  const chat = useChat()
  const [joining, setJoining] = useState(false)
  const join = async () => {
    setJoining(true)
    try {
      await chat.join(channel.id)
      showToast({ tone: 'success', text: t('channel.joined', { channel: label }), key: 'join' })
    } catch (error) {
      setJoining(false)
      // A 429 already has its own toast.
      if (!isApiError(error, 'rate_limited')) showToast({ tone: 'error', text: t('error.joinFailed'), key: 'join' })
    }
  }
  return (
    <div class="join-bar">
      <p class="join-bar__text">{t('channel.preview', { channel: label })}</p>
      <Button variant="primary" onClick={() => void join()} disabled={joining}>
        {t('channel.join')}
      </Button>
    </div>
  )
}
