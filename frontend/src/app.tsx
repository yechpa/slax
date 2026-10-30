/**
 * The application root: what to show for the session's state. Start-up (GET /me) and the
 * session's life are in session.ts; the signed-in app is the Workspace.
 */
import { useEffect } from 'preact/hooks'
import type { TurnstileClient } from './auth/turnstile.ts'
import { Brand } from './components/ui/Brand.tsx'
import { Button } from './components/ui/Button.tsx'
import { SignedOut } from './components/SignedOut.tsx'
import { Workspace, type ConnectRealtime } from './components/Workspace.tsx'
import { t } from './i18n/index.ts'
import { useLocale } from './i18n/useLocale.ts'
import { connectRealtime } from './realtime/echo.ts'
import { interceptLinks } from './router.ts'
import { boot } from './session.ts'
import { session } from './store/session.ts'
import { useTheme } from './useTheme.ts'

const defaultConnect: ConnectRealtime = () => connectRealtime(import.meta.env.VITE_REVERB_APP_KEY || 'slax-local-key')

type Props = {
  connect?: ConnectRealtime
  turnstile?: TurnstileClient
}

export function App({ connect = defaultConnect, turnstile }: Props) {
  // Every string and format follows the language; every colour the theme.
  useLocale()
  useTheme()
  const current = session.value

  useEffect(() => {
    // In-app links (sidebar) navigate without reloading the page.
    // Its own listener (not the shared function): no other instance's cleanup can remove it.
    const onClick = (event: MouseEvent) => interceptLinks(event)
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

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
            {t('app.unreachable')}
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
