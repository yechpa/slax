import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientState } from './api/client.ts'
import { App } from './app.tsx'
import type { TurnstileClient } from './auth/turnstile.ts'
import { setLocale, t } from './i18n/index.ts'
import { navigate, route, parseRoute } from './router.ts'
import { boot, endSession, installClientEvents } from './session.ts'
import { session } from './store/session.ts'
import { ME, channel, live } from './test/fixtures.ts'
import { FakeRealtime, fakeFetch, flush, type FakeHandler } from './test/fakes.ts'

let host: HTMLElement
let realtime: FakeRealtime
let uninstall: () => void
const turnstile: TurnstileClient = { token: async () => 'token' }

function mount(routes: Record<string, FakeHandler>) {
  const server = fakeFetch(routes)
  vi.stubGlobal('fetch', server.fetch)
  render(<App connect={async () => realtime} turnstile={turnstile} />, host)
  return server
}

/** Lets fetches, effects and renders settle. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await flush()
}

beforeEach(() => {
  localStorage.clear()
  setLocale('en')
  resetClientState()
  realtime = new FakeRealtime()
  uninstall = installClientEvents()
  history.replaceState(null, '', '/')
  route.value = parseRoute('/')
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  render(null, host)
  host.remove()
  uninstall()
  endSession(null)
  session.value = { status: 'loading' }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const signedInRoutes = (): Record<string, FakeHandler> => ({
  'GET /api/v1/me': () => ({ body: ME }),
  'GET /api/v1/channels': () => ({
    body: [channel(7, { name: 'general', topic: 'Announcements', member_count: 12 }), channel(8, { name: 'random', is_member: false })],
  }),
  'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(1, { body: 'hello team' })], has_more: false } }),
  'GET /api/v1/channels/8/messages': () => ({ body: { data: [], has_more: false } }),
})

describe('App', () => {
  it('shows the sign-in screen when there is no session', async () => {
    mount({ 'GET /api/v1/me': () => ({ status: 401, body: { message: 'Unauthenticated.' } }) })
    await boot()
    await settle()
    expect(host.querySelector('.signin__google')?.textContent).toBe('Continue with Google')
  })

  it('offline at start-up (the shell came from the service worker): says so, and comes back by itself with the network', async () => {
    let online = false
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
    const routes = signedInRoutes()
    const me = routes['GET /api/v1/me']
    routes['GET /api/v1/me'] = (request) => (online ? me(request) : 'network-error')
    mount(routes)
    await boot()
    await settle()
    expect(host.querySelector('.splash [role="alert"]')?.textContent).toBe(t('app.offline'))
    expect(host.querySelector('.message-list')).toBeNull()

    online = true
    window.dispatchEvent(new Event('online'))
    await settle()
    expect(host.querySelector('.splash')).toBeNull()
    expect(host.querySelector('[role="log"]')?.textContent).toContain('hello team')
  })

  it('a server that cannot be reached while the network is up is not called offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    mount({ 'GET /api/v1/me': () => 'network-error' })
    await boot()
    await settle()
    expect(host.querySelector('.splash [role="alert"]')?.textContent).toBe(t('app.unreachable'))
  })

  it('opens the first joined channel, sends from the composer and shows the reply once', async () => {
    const routes = signedInRoutes()
    routes['POST /api/v1/channels/7/messages'] = ({ body }) => ({
      status: 201,
      body: live(2, { body: (body as { body: string }).body, client_id: (body as { client_id: string }).client_id, user: { id: ME.id, name: ME.name, avatar_url: null } }),
    })
    mount(routes)
    await boot()
    await settle()

    expect(location.pathname).toBe('/c/7')
    expect(host.querySelector('.channel-header__name')?.textContent).toBe('#general')
    expect(host.querySelector('.channel-header__meta')?.textContent).toBe('12 members')
    expect(host.querySelector('[role="log"]')?.textContent).toContain('hello team')
    expect(document.title).toBe('#general · slax')

    const textarea = host.querySelector('textarea')!
    textarea.value = '  שלום https://example.test 👋  '
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()

    const bodies = [...host.querySelectorAll('.message__body')].map((b) => b.textContent)
    expect(bodies).toEqual(['hello team', 'שלום https://example.test 👋'])
    expect(textarea.value).toBe('')
  })

  it('shows a public channel read-only with a Join button', async () => {
    const routes = signedInRoutes()
    routes['POST /api/v1/channels/8/join'] = () => ({ body: channel(8, { name: 'random', is_member: true }) })
    mount(routes)
    await boot()
    await settle()
    navigate('/c/8')
    await settle()

    expect(host.querySelector('textarea')).toBeNull()
    const join = host.querySelector<HTMLButtonElement>('.join-bar .btn')!
    expect(join.textContent).toBe('Join channel')
    join.click()
    await settle()
    expect(host.querySelector('textarea')).not.toBeNull()
    expect(realtime.subscriptions.has('private-channel.8')).toBe(true)
  })

  it('opens the channel list as a drawer on small screens, with focus inside, and closes it on Escape', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('44rem'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
    mount(signedInRoutes())
    await boot()
    await settle()

    const toggle = host.querySelector<HTMLButtonElement>('.channel-header__nav')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe('app-sidebar')
    expect(document.getElementById('app-sidebar')).not.toBeNull()

    toggle.click()
    await settle()
    expect(host.querySelector('.channel-header__nav')?.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.getAttribute('href')).toBe('/c/7')
    expect((host.querySelector('.shell__main') as HTMLElement & { inert: boolean }).inert).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(host.querySelector('.channel-header__nav')?.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(host.querySelector('.channel-header__nav'))
    expect((host.querySelector('.shell__main') as HTMLElement & { inert: boolean }).inert).toBe(false)
  })

  it('goes back to the sign-in screen, explained, when the session expires', async () => {
    let expired = false
    const routes = signedInRoutes()
    routes['GET /api/v1/channels/7/messages'] = () =>
      expired ? { status: 401, body: { message: 'Unauthenticated.' } } : { body: { data: [], has_more: false } }
    const server = mount(routes)
    await boot()
    await settle()
    expired = true
    realtime.reconnect()
    await settle()

    expect(host.querySelector('.signin__error')?.textContent).toBe('Your session has ended. Please sign in again.')
    expect(location.pathname).toBe('/')
    expect(server.calls.length).toBeGreaterThan(0)
  })

  it('says so when the API answers 429, with the wait', async () => {
    const routes = signedInRoutes()
    routes['POST /api/v1/channels/7/messages'] = () => ({ status: 429, body: { message: 'Too Many Attempts.' }, headers: { 'Retry-After': '12' } })
    mount(routes)
    await boot()
    await settle()
    const textarea = host.querySelector('textarea')!
    textarea.value = 'hi'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()

    expect(host.querySelector('.toast--error')?.textContent).toContain('Too many requests. Try again in 12 seconds.')
    expect(host.querySelector('.message__error')?.textContent).toBe('Too many messages at once. Wait a moment, then retry.')
  })
})
