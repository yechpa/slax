/**
 * The application root: what to show for the session's state. Start-up (GET /me) and the
 * session's life are in session.ts; the signed-in app is the Workspace.
 */
import { useEffect } from 'preact/hooks'
import type { TurnstileClient } from './auth/turnstile.ts'
import { Brand } from './components/ui/Brand.tsx'
import { Button } from './components/ui/Button.tsx'
import { Legal } from './components/Legal.tsx'
import { SignedOut } from './components/SignedOut.tsx'
import { ConnectionBanner, Toasts } from './components/Toasts.tsx'
import { Workspace, type ConnectRealtime } from './components/Workspace.tsx'
import { t } from './i18n/index.ts'
import { useLocale } from './i18n/useLocale.ts'
import { publicConfig } from './lib/publicConfig.ts'
import { UpdateBanner } from './pwa/UpdateBanner.tsx'
import { connectRealtime } from './realtime/echo.ts'
import { interceptLinks, route } from './router.ts'
import { boot } from './session.ts'
import { session } from './store/session.ts'
import { useTheme } from './useTheme.ts'

// A deployment's key comes with the page (publicConfig); development and e2e builds have it from Vite.
const defaultConnect: ConnectRealtime = () =>
  connectRealtime(publicConfig('reverb-app-key') ?? (import.meta.env.VITE_REVERB_APP_KEY || 'slax-local-key'))

type Props = {
  connect?: ConnectRealtime
  turnstile?: TurnstileClient
}

export function App(props: Props) {
  const signedIn = session.value.status === 'signed-in'
  return (
    <>
      {/*
        The notices, in one band above the screen (app.css): the update (every screen: an old
        app must not keep running unnoticed after a deploy, register.ts), the connection and,
        anchored just under them, the toasts. In the page's flow, so they never cover each
        other, the header or the composer.
      */}
      <div class="top-bands">
        <UpdateBanner />
        {signedIn && <ConnectionBanner />}
        {signedIn && <Toasts />}
      </div>
      <Screen {...props} />
    </>
  )
}

function Screen({ connect = defaultConnect, turnstile }: Props) {
  // Every string and format follows the language; every colour the theme.
  useLocale()
  useTheme()
  const current = session.value

  useEffect(() => {
    // Offline at start-up (the shell came from the service worker): try again once the network is back.
    const onOnline = () => {
      if (session.peek().status === 'unreachable') void boot()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  useEffect(() => {
    // In-app links (sidebar) navigate without reloading the page.
    // Its own listener (not the shared function): no other instance's cleanup can remove it.
    const onClick = (event: MouseEvent) => interceptLinks(event)
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  // The legal pages are public: the same for everyone, whatever the session is doing.
  const here = route.value
  if (here.name === 'legal') return <Legal page={here.page} />

  switch (current.status) {
    case 'loading':
      return (
        <div class="splash" aria-busy="true">
          <Brand cursor />
          <p class="sr-only">{t('app.loading')}</p>
        </div>
      )
    case 'unreachable':
      return (
        <div class="splash">
          <Brand />
          <p class="splash__text" role="alert">
            {globalThis.navigator?.onLine === false ? t('app.offline') : t('app.unreachable')}
          </p>
          <Button variant="secondary" onClick={() => void boot()}>
            {t('action.retry')}
          </Button>
        </div>
      )
    case 'signed-out':
      return <SignedOut error={current.error} turnstile={turnstile} />
    case 'signed-in':
      return <Workspace connect={connect} />
  }
}
