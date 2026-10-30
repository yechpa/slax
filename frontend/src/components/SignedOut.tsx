/**
 * The sign-in screen: brand, tagline, language and theme, and one button. Google is the
 * only way in; Turnstile runs first (invisible unless Cloudflare needs a click), then
 * POST /auth/google/start hands back Google's URL and the browser goes there.
 *
 * Failures come back two ways, both shown translated: `/?auth_error=<code>` from the
 * callback (removed from the address bar once read), or the `error` prop (session expired,
 * account banned while signed in).
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { isApiError } from '../api/client.ts'
import { api } from '../api/endpoints.ts'
import { cloudflareTurnstile, TurnstileError, type TurnstileClient } from '../auth/turnstile.ts'
import { getLocale, t } from '../i18n/index.ts'
import { getTheme } from '../theme.ts'
import { Brand } from './ui/Brand.tsx'
import { Button } from './ui/Button.tsx'
import { LocaleSwitcher } from './ui/LocaleSwitcher.tsx'
import { ThemeSwitcher } from './ui/ThemeSwitcher.tsx'

const KNOWN_ERRORS = new Set([
  'invalid_state',
  'invalid_token',
  'provider_error',
  'email_unverified',
  'banned',
  'rate_limited',
  'turnstile_failed',
  'turnstile_unavailable',
  'session_expired',
  'network',
])

export const authErrorText = (code: string) => t(KNOWN_ERRORS.has(code) ? `auth.error.${code}` : 'auth.error.generic')

/** Reads `?auth_error=` once and removes it from the address bar (no reload, history kept clean). */
function takeAuthErrorFromUrl(): string | null {
  const url = new URL(location.href)
  const code = url.searchParams.get('auth_error')
  if (code === null) return null
  url.searchParams.delete('auth_error')
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  return code.slice(0, 40)
}

/**
 * Where the sign-in may send the browser: Google's consent page over HTTPS, nothing else.
 * In development and end-to-end runs the fake identity provider sends it back to this
 * app's own origin instead, which is allowed only there (`allowSameOrigin`).
 */
export function isAllowedSignInRedirect(value: string, { allowSameOrigin }: { allowSameOrigin: boolean }): boolean {
  let url: URL
  try {
    url = new URL(value, location.href)
  } catch {
    return false
  }
  if (url.protocol === 'https:' && url.hostname === 'accounts.google.com' && url.username === '' && url.password === '') return true
  return allowSameOrigin && url.origin === location.origin
}

/** The Vite dev server, or a build made for end-to-end tests (VITE_E2E=true). */
const fakeProviderAllowed = () => import.meta.env.DEV || import.meta.env.VITE_E2E === 'true'

type Props = {
  /** Why the previous session ended, if it did (session_expired, banned). */
  error?: string | null
  turnstile?: TurnstileClient
  /** Leaves for Google (a seam for tests). */
  goTo?: (url: string) => void
}

export function SignedOut({ error = null, turnstile = cloudflareTurnstile, goTo = (url) => location.assign(url) }: Props) {
  const [failure, setFailure] = useState<string | null>(() => takeAuthErrorFromUrl() ?? error)
  const [pending, setPending] = useState(false)
  const widget = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    document.title = 'slax'
  }, [])

  const start = async () => {
    if (pending || !widget.current) return
    setPending(true)
    setFailure(null)
    try {
      const token = await turnstile.token(widget.current, { locale: getLocale(), theme: getTheme() })
      const { redirect_url: target } = await api.startGoogle(token)
      if (!isAllowedSignInRedirect(target, { allowSameOrigin: fakeProviderAllowed() })) throw new Error('unexpected redirect')
      // Stays "pending" while the browser leaves for Google.
      goTo(target)
    } catch (caught) {
      setPending(false)
      setFailure(failureCode(caught))
      button.current?.focus()
    }
  }

  return (
    <div class="signin">
      <div class="signin__prefs">
        <LocaleSwitcher />
        <ThemeSwitcher />
      </div>
      <main class="signin__main">
        <section class="signin__card" aria-labelledby="signin-title">
          <p class="signin__brand">
            <Brand cursor />
          </p>
          <p class="signin__tagline">{t('app.tagline')}</p>
          <h1 class="signin__title" id="signin-title">
            {t('auth.title')}
          </h1>
          {/* Always in the page, so screen readers announce the message when it appears. */}
          <div class="signin__alert" role="alert">
            {failure && <p class="signin__error">{authErrorText(failure)}</p>}
          </div>
          <Button
            ref={button}
            variant="primary"
            class="signin__google"
            onClick={() => void start()}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? t('auth.pending') : t('auth.google')}
          </Button>
          <div class="signin__turnstile" ref={widget} />
          <p class="signin__note">{t('auth.note')}</p>
        </section>
      </main>
    </div>
  )
}

function failureCode(error: unknown): string {
  if (error instanceof TurnstileError) return error.reason === 'unavailable' ? 'turnstile_unavailable' : 'turnstile_failed'
  if (isApiError(error)) {
    if (error.code === 'network') return 'network'
    if (error.status === 429) return 'rate_limited'
    if (error.code === 'turnstile_failed') return 'turnstile_failed'
  }
  return 'generic'
}
