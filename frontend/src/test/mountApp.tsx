/**
 * The whole app on a fake server and a fake realtime client, signed in as ME, for
 * integration tests of the chat (threads, files, dialogs). Call `cleanup` after each test.
 */
import { render } from 'preact'
import { vi } from 'vitest'
import { resetClientState } from '../api/client.ts'
import { App } from '../app.tsx'
import { setLocale, type Locale } from '../i18n/index.ts'
import { parseRoute, route } from '../router.ts'
import { boot, endSession, installClientEvents } from '../session.ts'
import { resetPeople } from '../store/people.ts'
import { session } from '../store/session.ts'
import { FakeRealtime, fakeFetch, flush, type FakeHandler } from './fakes.ts'
import { ME } from './fixtures.ts'

export interface Mounted {
  host: HTMLElement
  realtime: FakeRealtime
  server: ReturnType<typeof fakeFetch>
  cleanup: () => void
}

/** Lets fetches, effects and renders settle. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await flush()
}

export async function mountApp(routes: Record<string, FakeHandler>, path = '/', { locale = 'en' }: { locale?: Locale } = {}): Promise<Mounted> {
  localStorage.clear()
  setLocale(locale)
  resetClientState()
  const realtime = new FakeRealtime()
  const uninstall = installClientEvents()
  history.replaceState(null, '', path)
  route.value = parseRoute(path)
  const host = document.createElement('div')
  document.body.append(host)
  const server = fakeFetch({
    'GET /api/v1/me': () => ({ body: ME }),
    'POST /api/v1/presence/heartbeat': () => ({ status: 204 }),
    'GET /api/v1/presence': () => ({ body: {} }),
    ...routes,
  })
  vi.stubGlobal('fetch', server.fetch)
  render(<App connect={async () => realtime} turnstile={{ token: async () => 'token' }} />, host)
  await boot()
  await settle()
  return {
    host,
    realtime,
    server,
    cleanup() {
      render(null, host)
      host.remove()
      uninstall()
      endSession(null)
      session.value = { status: 'loading' }
      resetPeople()
      vi.unstubAllGlobals()
      document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
    },
  }
}

/** Types into a field as a person would (value, then an input event). */
export function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

export const key = (target: EventTarget, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

/** Text without the isolates t() puts around inserted values. */
export const plain = (text: string | null | undefined) => (text ?? '').replace(/[⁨⁩]/g, '')
