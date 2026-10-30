/**
 * "Browse channels": every public channel, filtered by name, to open or join. The list is
 * refetched when the dialog opens: channels created by others are not pushed, and finding
 * them is what this dialog is for.
 */
import { useEffect, useState } from 'preact/hooks'
import { isApiError } from '../api/client.ts'
import type { Channel } from '../api/types.ts'
import { plural, t } from '../i18n/index.ts'
import { channelPath, navigate } from '../router.ts'
import { rooms } from '../store/channels.ts'
import { showToast } from '../store/ui.ts'
import { Button } from './ui/Button.tsx'
import { ChannelName } from './ui/ChannelName.tsx'
import { Dialog } from './ui/Dialog.tsx'
import { TextField } from './ui/TextField.tsx'
import { useChat } from './chatContext.ts'

export function BrowseChannelsDialog({ onClose }: { onClose: () => void }) {
  const chat = useChat()
  const [filter, setFilter] = useState('')
  const [joining, setJoining] = useState<number | null>(null)
  useEffect(() => {
    // The known list shows at once; a failure keeps it (the periodic refresh tries again).
    chat.refreshChannels().catch(() => undefined)
  }, [chat])
  const query = filter.trim().toLowerCase().replace(/^#/, '')
  const list = rooms.value.filter((c) => c.kind === 'public' && (query === '' || (c.name ?? '').includes(query)))

  const open = (channel: Channel) => {
    onClose()
    navigate(channelPath(channel.id))
  }

  const join = async (channel: Channel) => {
    setJoining(channel.id)
    try {
      await chat.join(channel.id)
      open(channel)
      showToast({ tone: 'success', text: t('channel.joined', { channel: `#${channel.name}` }), key: 'join' })
    } catch (error) {
      setJoining(null)
      if (!isApiError(error, 'rate_limited')) showToast({ tone: 'error', text: t('error.joinFailed'), key: 'join' })
    }
  }

  return (
    <Dialog title={t('channel.browse.title')} onClose={onClose} class="dialog--browse">
      <TextField label={t('channel.browse.filter')} value={filter} autocomplete="off" spellcheck={false} onInput={(event) => setFilter(event.currentTarget.value)} />
      <p class="sr-only" role="status">
        {plural('channel.browse.count', list.length)}
      </p>
      {list.length === 0 ? (
        <p class="browse__empty">{query === '' ? t('channel.browse.empty') : t('channel.browse.none', { query: filter.trim() })}</p>
      ) : (
        <ul class="browse__list">
          {list.map((channel) => (
            <li class="browse__item" key={channel.id}>
              <div class="browse__info">
                <a
                  class="browse__name"
                  href={channelPath(channel.id)}
                  onClick={(event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                    event.preventDefault()
                    open(channel)
                  }}
                >
                  <ChannelName name={channel.name ?? ''} />
                </a>
                <span class="browse__meta">{plural('channel.members', channel.member_count)}</span>
                {channel.topic && (
                  <span class="browse__topic" title={channel.topic}>
                    <span class="clip-own" dir="auto">
                      {channel.topic}
                    </span>
                  </span>
                )}
              </div>
              {channel.is_member ? (
                <span class="browse__joined">{t('channel.browse.joined')}</span>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => void join(channel)} disabled={joining !== null}>
                  {t('action.join')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
