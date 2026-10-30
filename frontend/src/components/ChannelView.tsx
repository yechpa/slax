/**
 * One channel or conversation: header, message log and composer (or, for a public
 * channel the user has not joined, a read-only notice with a Join button), and its
 * thread panel when one is open. Files dropped on it go to its composer.
 */
import type { Ref } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { isApiError } from '../api/client.ts'
import type { Channel } from '../api/types.ts'
import { plural, t } from '../i18n/index.ts'
import { writePref } from '../lib/prefs.ts'
import { channelPath, navigate } from '../router.ts'
import { isDirect } from '../store/channels.ts'
import { channelKey, timeline } from '../store/messages.ts'
import { me } from '../store/session.ts'
import { showToast } from '../store/ui.ts'
import { Button } from './ui/Button.tsx'
import { ChannelName } from './ui/ChannelName.tsx'
import { ChannelDetails } from './ChannelDetails.tsx'
import { channelLabel } from './channelNames.ts'
import { ChatComposer, addFiles } from './ChatComposer.tsx'
import { useChat } from './chatContext.ts'
import { DropZone } from './DropZone.tsx'
import { MessageList } from './MessageList.tsx'
import { NavToggle } from './NavToggle.tsx'
import { ThreadPanel } from './ThreadPanel.tsx'
import { Typing } from './Typing.tsx'

export const LAST_CHANNEL_KEY = 'slax.lastChannel'

type Props = {
  channel: Channel
  /** The thread open beside it (/c/:id/t/:messageId). */
  threadId: number | null
  /** The thread covers the conversation (narrow screens): everything else is inert. */
  threadModal: boolean
  navOpen: boolean
  onToggleNav: () => void
  toggleRef: Ref<HTMLButtonElement>
}

export function ChannelView({ channel, threadId, threadModal, navOpen, onToggleNav, toggleRef }: Props) {
  const chat = useChat()
  const meId = me.value?.id ?? null
  const label = channelLabel(channel, meId)
  const messages = timeline(channelKey(channel.id)).value
  const [details, setDetails] = useState(false)
  // The "new messages" rule stays where the reading stopped when the channel was opened.
  const [unreadAfter, setUnreadAfter] = useState(() => (channel.unread_count > 0 ? (channel.last_read_message_id ?? 0) : null))
  const behind = threadModal || undefined

  useEffect(() => {
    chat.openChannel(channel.id)
    writePref(LAST_CHANNEL_KEY, String(channel.id))
    return () => chat.closeChannel(channel.id)
  }, [chat, channel.id])

  useEffect(() => {
    document.title = `${label.replace(/[⁨⁩]/g, '')} · slax`
  }, [label])

  const main = (
    <>
      <MessageList
        label={label}
        direct={isDirect(channel)}
        timeline={messages}
        meId={meId}
        unreadAfter={unreadAfter}
        place={{ channelId: channel.id, canPost: channel.is_member, inThread: false }}
        inert={behind}
        onLoadOlder={() => void chat.loadOlder(channel.id)}
        onRetryOlder={() => void chat.loadOlder(channel.id, { force: true })}
        onRetryLoad={() => void chat.loadLatest(channel.id)}
        onRetryRefresh={() => chat.retryRefresh(channel.id)}
        onRetry={(clientId) => chat.retry(channel.id, clientId)}
        onDiscard={(clientId) => chat.discard(channel.id, clientId)}
        onAtBottom={(stillReadable) => chat.noteReadable(channel.id, stillReadable)}
      />

      <footer class="shell__footer" inert={behind}>
        {/* Keeps its line, so the composer never jumps. */}
        <Typing channelId={channel.id} />
        {channel.is_member ? (
          <ChatComposer channel={channel} label={label} onSent={() => setUnreadAfter(null)} />
        ) : (
          <JoinBar channel={channel} label={label} />
        )}
      </footer>
    </>
  )

  return (
    <>
      <header class="channel-header" inert={behind}>
        <NavToggle open={navOpen} onToggle={onToggleNav} buttonRef={toggleRef} />
        <div class="channel-header__title">
          <h2 class="channel-header__name" id="channel-title">
            {isDirect(channel) ? <bdi>{label}</bdi> : <ChannelName name={channel.name ?? ''} />}
          </h2>
          <button type="button" class="channel-header__meta channel-header__details" aria-haspopup="dialog" onClick={() => setDetails(true)}>
            {channel.kind === 'private' && <>{t('channel.private')} · </>}
            {channel.kind === 'group_dm' && <>{t('channel.group')} · </>}
            {plural('channel.members', channel.member_count)}
          </button>
          {channel.topic && (
            // Its own direction (clipped at its own end), aligned with the interface (see app.css).
            <span class="channel-header__topic" dir="auto" title={channel.topic}>
              {channel.topic}
            </span>
          )}
        </div>
      </header>

      {channel.is_member ? <DropZone onFiles={(files) => addFiles(chat, channel.id, null, files)}>{main}</DropZone> : main}

      {threadId !== null && (
        <ThreadPanel key={threadId} channel={channel} parentId={threadId} label={label} modal={threadModal} onClose={() => navigate(channelPath(channel.id))} />
      )}
      {details && <ChannelDetails channel={channel} label={label} onClose={() => setDetails(false)} />}
    </>
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
