/**
 * Cloudflare Turnstile, the anti-bot check run before Google sign-in starts
 * (POST /auth/google/start verifies its token server-side).
 *
 * The script is loaded on demand, the first time someone clicks "Continue with Google",
 * and the widget is rendered explicitly in "interaction-only" mode: invisible unless
 * Cloudflare needs the person to click. Each attempt renders a fresh widget (a token is
 * single use) and removes it once it answered.
 *
 * The site key comes from VITE_TURNSTILE_SITE_KEY (in development, Cloudflare's public
 * always-pass test key). Content-Security-Policy needs challenges.cloudflare.com in
 * script-src and frame-src.
 */
import type { Locale } from '../i18n/index.ts'
import type { Theme } from '../theme.ts'

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
/** Cloudflare's published always-pass test key: public, for development only. */
const TEST_SITE_KEY = '1x00000000000000000000AA'

export interface TurnstileClient {
  /** Runs the check inside `container` and resolves with a single-use token. */
  token(container: HTMLElement, options: { locale: Locale; theme: Theme }): Promise<string>
}

export class TurnstileError extends Error {
  readonly reason: 'unavailable' | 'failed' | 'expired'

  constructor(reason: 'unavailable' | 'failed' | 'expired') {
    super(`turnstile ${reason}`)
    this.name = 'TurnstileError'
    this.reason = reason
  }
}

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let loading: Promise<TurnstileApi> | null = null

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new TurnstileError('unavailable')))
    script.onerror = () => {
      script.remove()
      reject(new TurnstileError('unavailable'))
    }
    document.head.append(script)
  }).catch((error: unknown) => {
    loading = null // a later click tries again
    throw error
  })
  return loading
}

export const cloudflareTurnstile: TurnstileClient = {
  async token(container, { locale, theme }) {
    const turnstile = await loadScript()
    return new Promise<string>((resolve, reject) => {
      const settle = (finish: () => void) => {
        finish()
        // After the callback returns: removing the widget from inside its own callback is not safe.
        setTimeout(() => {
          if (widgetId !== undefined) turnstile.remove(widgetId)
        })
      }
      container.replaceChildren()
      const widgetId = turnstile.render(container, {
        sitekey: import.meta.env.VITE_TURNSTILE_SITE_KEY || TEST_SITE_KEY,
        action: 'login',
        appearance: 'interaction-only',
        size: 'flexible',
        theme: theme === 'console' ? 'dark' : 'light',
        language: locale,
        callback: (token: string) => settle(() => resolve(token)),
        'error-callback': () => settle(() => reject(new TurnstileError('failed'))),
        'expired-callback': () => settle(() => reject(new TurnstileError('expired'))),
        'timeout-callback': () => settle(() => reject(new TurnstileError('expired'))),
      })
    })
  },
}
