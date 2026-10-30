/**
 * The signed-in application: the chat controller and its realtime connection for the
 * life of the session, and the shell around the current channel.
 *
 * Small screens (the shell narrower than 44rem): the channel list is a drawer opened from
 * the header. While it is open the conversation behind is inert, focus moves into the
 * list, and Escape, the backdrop or following a link closes it and returns focus to the
 * toggle.
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
import { connection, everConnected, navOpen, realtimeDown } from '../store/ui.ts'
import { Button } from './ui/Button.tsx'
import { EmptyState } from './ui/EmptyState.tsx'
import { ChannelView, LAST_CHANNEL_KEY } from './ChannelView.tsx'
import { ChatContext } from './chatContext.ts'
import { Skeleton } from './MessageList.tsx'
import { NavToggle } from './NavToggle.tsx'
import { Sidebar } from './Sidebar.tsx'
import { ConnectionBanner, Toasts } from './Toasts.tsx'

/** How long the socket may be down before the banner says so: a blip is not news. */
const BANNER_DELAY_MS = 2000
/** The very first connection gets longer (slow networks, cold start). */
const FIRST_CONNECT_GRACE_MS = 8000
const NARROW = '(width < 44rem)'

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
    chat.start().catch(() => !cancelled && setLoadFailed(true))
    connect().then(
      (connected) => {
        if (cancelled) return connected.disconnect()
        realtime = connected
        chat.attachRealtime(connected)
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

  const retryLoad = () => {
    setLoadFailed(false)
    chat.start().catch(() => setLoadFailed(true))
  }

  return (
    <ChatContext.Provider value={chat}>
      <Shell loadFailed={loadFailed} onRetryLoad={retryLoad} />
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

function Shell({ loadFailed, onRetryLoad }: { loadFailed: boolean; onRetryLoad: () => void }) {
  const current = route.value
  const currentId = current.name === 'channel' ? current.id : null
  const channel = currentId === null ? undefined : channelById.value.get(currentId)
  const open = navOpen.value
  const narrow = useNarrow()
  const drawer = open && narrow
  const sidebarRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const wasDrawer = useRef(false)

  // "/" (or an unknown path) opens a channel as soon as the list is known.
  useEffect(() => {
    if (current.name === 'channel' || !channelsLoaded.value) return
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
  if (channel) {
    main = <ChannelView key={channel.id} channel={channel} navOpen={open} onToggleNav={toggle} toggleRef={toggleRef} />
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
      <a class="skip-link" href="#messages">
        {t('a11y.skipToContent')}
      </a>
      <Sidebar currentId={currentId} onNavigate={closeAfterNavigation} navRef={sidebarRef} />
      {drawer && <div class="shell__scrim" aria-hidden="true" onClick={() => (navOpen.value = false)} />}
      <section class="shell__main" aria-labelledby={channel ? 'channel-title' : undefined} inert={drawer || undefined}>
        {main}
      </section>
    </div>
  )
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => globalThis.matchMedia?.(NARROW).matches ?? false)
  useEffect(() => {
    const query = globalThis.matchMedia?.(NARROW)
    if (!query) return
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return narrow
}
