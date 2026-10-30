/**
 * The signed-in application: the chat controller and its realtime connection for the
 * life of the session, and the shell around the current channel.
 *
 * Small screens (the shell narrower than 44rem): the channel list is a drawer opened from
 * the header. While it is open the conversation behind is inert, focus moves into the
 * list, and Escape, the backdrop or following a link closes it and returns focus to the
 * toggle.
 *
 * A thread (/c/:id/t/:messageId) opens beside the conversation, or over it as a modal
 * drawer when the screen is narrower than 64rem (the rest is then inert).
 *
 * Also here for the session's life: presence (heartbeats, the workspace presence
 * channel), the channel list refreshed every minute and when the tab comes back (new
 * conversations and invitations are not pushed), and the sidebar's dialogs.
 */
import { effect } from '@preact/signals'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { api } from '../api/endpoints.ts'
import { t } from '../i18n/index.ts'
import { readPref } from '../lib/prefs.ts'
import type { Realtime } from '../realtime/echo.ts'
import { channelPath, navigate, route } from '../router.ts'
import { channelById, channels, channelsLoaded, rooms } from '../store/channels.ts'
import { createChat, type Chat } from '../store/chat.ts'
import { me } from '../store/session.ts'
import { connection, everConnected, navOpen, openDialog, realtimeDown } from '../store/ui.ts'
import { Button } from './ui/Button.tsx'
import { EmptyState } from './ui/EmptyState.tsx'
import { Admin } from './Admin.tsx'
import { BrowseChannelsDialog } from './BrowseChannelsDialog.tsx'
import { ChannelView, LAST_CHANNEL_KEY } from './ChannelView.tsx'
import { ChatContext } from './chatContext.ts'
import { CreateChannelDialog } from './CreateChannelDialog.tsx'
import { NewMessageDialog } from './NewMessageDialog.tsx'
import { Skeleton } from './MessageList.tsx'
import { NavToggle } from './NavToggle.tsx'
import { Sidebar } from './Sidebar.tsx'
import { ConnectionBanner, Toasts } from './Toasts.tsx'

/** How long the socket may be down before the banner says so: a blip is not news. */
const BANNER_DELAY_MS = 2000
/** The very first connection gets longer (slow networks, cold start). */
const FIRST_CONNECT_GRACE_MS = 8000
const NARROW = '(width < 44rem)'
/** Below this, a thread covers the conversation instead of sitting beside it. */
const THREAD_DRAWER = '(width < 64rem)'
/** The channel list is refetched this often, and when the tab comes back after this long. */
const CHANNELS_REFRESH_MS = 60_000
const CHANNELS_ON_RETURN_MS = 15_000

export type ConnectRealtime = () => Promise<Realtime>

type Props = {
  connect: ConnectRealtime
  /** Tests and the screenshot fixtures pass their own controller. */
  chat?: Chat
}

export function Workspace({ connect, chat: given }: Props) {
  const [chat] = useState(() => given ?? createChat({ api, realtime: null }))
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let realtime: Realtime | null = null
    let stopWatching: (() => void) | null = null
    let unavailable: ReturnType<typeof setTimeout> | undefined
    const user = me.peek()
    chat.start().catch(() => !cancelled && setLoadFailed(true))
    if (user) chat.presence.start(user.id)
    connect().then(
      (connected) => {
        if (cancelled) return connected.disconnect()
        realtime = connected
        chat.attachRealtime(connected)
        chat.presence.attach(connected, user?.workspace_id ?? null)
        stopWatching = watchConnection(connected)
      },
      () => {
        // No realtime at all (blocked WebSocket): the banner says so after the grace period.
        if (!cancelled) unavailable = setTimeout(() => (realtimeDown.value = true), FIRST_CONNECT_GRACE_MS)
      },
    )
    return () => {
      cancelled = true
      clearTimeout(unavailable)
      stopWatching?.()
      chat.stop()
      realtime?.disconnect()
    }
  }, [chat, connect])

  // New conversations and invitations to private rooms are not pushed: the list is refetched.
  useEffect(() => {
    let last = Date.now()
    const refresh = () => {
      last = Date.now()
      void chat.refreshChannels().catch(() => undefined)
    }
    const timer = setInterval(refresh, CHANNELS_REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > CHANNELS_ON_RETURN_MS) refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [chat])

  // Files dropped anywhere but on a drop zone must not make the browser open them (and leave the app).
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      if ([...(event.dataTransfer?.types ?? [])].includes('Files')) event.preventDefault()
    }
    addEventListener('dragover', swallow)
    addEventListener('drop', swallow)
    return () => {
      removeEventListener('dragover', swallow)
      removeEventListener('drop', swallow)
    }
  }, [])

  const retryLoad = () => {
    setLoadFailed(false)
    chat.start().catch(() => setLoadFailed(true))
  }

  return (
    <ChatContext.Provider value={chat}>
      <Shell loadFailed={loadFailed} onRetryLoad={retryLoad} />
      <Dialogs />
      <ConnectionBanner />
      <Toasts />
    </ChatContext.Provider>
  )
}

function watchConnection(realtime: Realtime): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const dispose = effect(() => {
    const state = realtime.state.value
    connection.value = state
    clearTimeout(timer)
    if (state === 'connected') {
      everConnected.value = true
      realtimeDown.value = false
    } else {
      timer = setTimeout(() => (realtimeDown.value = true), everConnected.peek() ? BANNER_DELAY_MS : FIRST_CONNECT_GRACE_MS)
    }
  })
  return () => {
    clearTimeout(timer)
    dispose()
  }
}

/** Where "/" leads: the last channel opened on this device, else the first joined room. */
function defaultChannelId(): number | null {
  const last = Number(readPref(LAST_CHANNEL_KEY))
  if (channelById.value.has(last)) return last
  const list = rooms.value
  return (list.find((c) => c.is_member) ?? list[0] ?? channels.value[0])?.id ?? null
}

/** The sidebar's dialogs, one at a time. */
function Dialogs() {
  const close = () => (openDialog.value = null)
  switch (openDialog.value) {
    case 'create-channel':
      return <CreateChannelDialog onClose={close} />
    case 'browse-channels':
      return <BrowseChannelsDialog onClose={close} />
    case 'new-message':
      return <NewMessageDialog onClose={close} />
    default:
      return null
  }
}

function Shell({ loadFailed, onRetryLoad }: { loadFailed: boolean; onRetryLoad: () => void }) {
  const current = route.value
  const currentId = current.name === 'channel' ? current.id : null
  const adminPage = current.name === 'admin'
  const threadId = current.name === 'channel' ? current.thread : null
  const channel = currentId === null ? undefined : channelById.value.get(currentId)
  const open = navOpen.value
  const narrow = useMedia(NARROW)
  const threadModal = useMedia(THREAD_DRAWER) && threadId !== null && channel !== undefined
  const drawer = open && narrow
  const sidebarRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const wasDrawer = useRef(false)

  // "/" (or an unknown path) opens a channel as soon as the list is known.
  useEffect(() => {
    if (current.name === 'channel' || current.name === 'admin' || !channelsLoaded.value) return
    const id = defaultChannelId()
    if (id !== null) navigate(channelPath(id), { replace: true })
  }, [current, channelsLoaded.value])

  // Wide again: there is no drawer to keep open.
  useEffect(() => {
    if (!narrow && open) navOpen.value = false
  }, [narrow, open])

  // Focus into the drawer when it opens, back to its toggle when it closes.
  useLayoutEffect(() => {
    if (drawer && !wasDrawer.current) {
      const target = sidebarRef.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? sidebarRef.current?.querySelector<HTMLElement>('a[href]')
      ;(target ?? sidebarRef.current)?.focus()
    } else if (!drawer && wasDrawer.current) {
      toggleRef.current?.focus()
    }
    wasDrawer.current = drawer
  }, [drawer])

  useEffect(() => {
    if (!drawer) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') navOpen.value = false
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawer])

  const toggle = () => (navOpen.value = !navOpen.peek())
  const closeAfterNavigation = () => {
    if (navOpen.peek()) navOpen.value = false
  }

  let main
  if (adminPage) {
    main = <Admin navOpen={open} onToggleNav={toggle} toggleRef={toggleRef} />
  } else if (channel) {
    main = (
      <ChannelView
        key={channel.id}
        channel={channel}
        threadId={threadId}
        threadModal={threadModal}
        navOpen={open}
        onToggleNav={toggle}
        toggleRef={toggleRef}
      />
    )
  } else {
    let message: string | null = null
    if (loadFailed) message = t('channel.loadError')
    else if (channelsLoaded.value) message = currentId !== null ? t('error.notFound') : channels.value.length === 0 ? t('channel.none') : t('channel.pick')
    main = (
      <>
        <header class="channel-header">
          <NavToggle open={open} onToggle={toggle} buttonRef={toggleRef} />
        </header>
        <div class="message-pane message-pane--empty" id="messages" tabIndex={-1}>
          {!message && !channelsLoaded.value && <Skeleton />}
          {message && (
            <EmptyState>
              {message}
              {loadFailed && (
                <>
                  {' '}
                  <Button variant="quiet" size="sm" onClick={onRetryLoad}>
                    {t('action.retry')}
                  </Button>
                </>
              )}
            </EmptyState>
          )}
        </div>
        <div />
      </>
    )
  }

  return (
    <div class={open ? 'shell shell--app shell--nav-open' : 'shell shell--app'}>
      <a class="skip-link" href="#messages" inert={threadModal || undefined}>
        {t('a11y.skipToContent')}
      </a>
      <Sidebar currentId={currentId} onNavigate={closeAfterNavigation} navRef={sidebarRef} inert={threadModal || undefined} />
      {drawer && <div class="shell__scrim" aria-hidden="true" onClick={() => (navOpen.value = false)} />}
      <section
        class={threadId !== null && channel ? 'shell__main shell__main--thread' : 'shell__main'}
        aria-labelledby={channel || adminPage ? 'channel-title' : undefined}
        inert={drawer || undefined}
      >
        {main}
      </section>
    </div>
  )
}

function useMedia(media: string): boolean {
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(media).matches ?? false)
  useEffect(() => {
    const query = globalThis.matchMedia?.(media)
    if (!query) return
    const update = () => setMatches(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [media])
  return matches
}
