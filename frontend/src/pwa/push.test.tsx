import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Me } from '../api/types.ts'
import { UserMenu } from '../components/UserMenu.tsx'
import { setLocale, t } from '../i18n/index.ts'
import { route } from '../router.ts'
import { endSession } from '../session.ts'
import { session } from '../store/session.ts'
import { fakeFetch, flush, type FakeHandler } from '../test/fakes.ts'
import { PushSettings } from './PushSettings.tsx'
import {
  disablePush,
  dropPushLocally,
  enablePush,
  forgetPushOnSignOut,
  initPush,
  listenForNotificationClicks,
  PUSH_OWNER_KEY,
  pushStatus,
  pushSupport,
  resetPush,
  sendTestPush,
} from './push.ts'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'

/** A VAPID public key: 65 bytes, base64url (generated for this test, not a real deployment's). */
const KEY_BYTES = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : (i * 7) % 256))
const toB64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const PUBLIC_KEY = toB64url(KEY_BYTES)
const OTHER_KEY = toB64url(new Uint8Array(65).map((_, i) => (i === 0 ? 4 : 1)))
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1'

const ME: Me = { id: 1, name: 'Ada', email: 'ada@example.test', avatar_url: null, locale: 'en', theme: 'console', is_admin: false, workspace_id: 1 }

interface FakeSubscription {
  endpoint: string
  options: { applicationServerKey: ArrayBuffer | null }
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } }
  unsubscribe: ReturnType<typeof vi.fn>
}

function subscription(key = PUBLIC_KEY, endpoint = ENDPOINT): FakeSubscription {
  const bytes = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  return {
    endpoint,
    options: { applicationServerKey: bytes.buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'BROWSER_P256DH', auth: 'BROWSER_AUTH' } }),
    unsubscribe: vi.fn(async () => true),
  }
}

/** The browser's push machinery: Notification permission, a service worker registration, its PushManager. */
function fakeBrowser({
  userAgent = ANDROID_CHROME,
  standalone = false,
  permission = 'default' as NotificationPermission,
  answer = 'granted' as NotificationPermission,
  existing = null as FakeSubscription | null,
  push = true,
  registration = true,
} = {}) {
  let current = existing
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      current = subscription(toB64url(new Uint8Array(options.applicationServerKey)))
      return current
    }),
  }
  const swListeners = new Set<(event: MessageEvent) => void>()
  const serviceWorker = {
    getRegistration: vi.fn(async () => (registration ? { pushManager } : undefined)),
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => type === 'message' && swListeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => swListeners.delete(listener),
  }
  vi.stubGlobal('navigator', { ...navigator, userAgent, platform: '', maxTouchPoints: 0, standalone, serviceWorker })
  vi.stubGlobal('matchMedia', (query: string) => ({ media: query, matches: query === '(display-mode: standalone)' ? standalone : false, addEventListener() {}, removeEventListener() {} }))
  const Notification = { permission, requestPermission: vi.fn(async () => answer) }
  vi.stubGlobal('Notification', Notification)
  if (push) vi.stubGlobal('PushManager', function PushManager() {})
  else vi.stubGlobal('PushManager', undefined)
  return {
    pushManager,
    Notification,
    current: () => current,
    fromWorker: (data: unknown) => swListeners.forEach((listener) => listener(new MessageEvent('message', { data }))),
  }
}

function server(routes: Record<string, FakeHandler> = {}) {
  const fake = fakeFetch({
    'GET /api/v1/push/public-key': () => ({ body: { public_key: PUBLIC_KEY } }),
    'POST /api/v1/push/subscriptions': () => ({ status: 204 }),
    'DELETE /api/v1/push/subscriptions': () => ({ status: 204 }),
    'POST /api/v1/push/test': () => ({ status: 202, body: { devices: 1 } }),
    'POST /api/v1/auth/logout': () => ({ status: 204 }),
    ...routes,
  })
  vi.stubGlobal('fetch', fake.fetch)
  return fake
}

const pushCalls = (calls: { method: string; path: string }[]) => calls.filter((c) => c.path.startsWith('/api/v1/push') || c.path === '/api/v1/auth/logout').map((c) => `${c.method} ${c.path}`)

let host: HTMLElement

beforeEach(() => {
  setLocale('en')
  resetPush()
  localStorage.clear()
  session.value = { status: 'signed-in', me: ME }
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  render(null, host)
  host.remove()
  vi.unstubAllGlobals()
  session.value = { status: 'loading' }
})

describe('pushSupport', () => {
  it('iPhone outside the installed app: install first (Safari has no push in a tab)', () => {
    fakeBrowser({ userAgent: IPHONE, standalone: false, push: false })
    expect(pushSupport()).toBe('install-first')
  })

  it('iPhone in the installed app (iOS 16.4+): supported', () => {
    fakeBrowser({ userAgent: IPHONE, standalone: true })
    expect(pushSupport()).toBe('supported')
  })

  it('a browser without the Push API: unsupported', () => {
    fakeBrowser({ push: false })
    expect(pushSupport()).toBe('unsupported')
  })

  it('Chrome on Android: supported', () => {
    fakeBrowser()
    expect(pushSupport()).toBe('supported')
  })
})

describe('initPush (when the account menu appears)', () => {
  it('hides everything when the server has no VAPID keys (404), and asks nothing', async () => {
    const browser = fakeBrowser()
    server({ 'GET /api/v1/push/public-key': () => ({ status: 404, body: { error: 'push_disabled' } }) })
    await initPush()
    expect(pushStatus.value).toBe('hidden')
    expect(browser.Notification.requestPermission).not.toHaveBeenCalled()
  })

  it('never asks for permission by itself: off until the person turns it on', async () => {
    const browser = fakeBrowser()
    const { calls } = server()
    await initPush()
    expect(pushStatus.value).toBe('off')
    expect(browser.Notification.requestPermission).not.toHaveBeenCalled()
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled()
    expect(pushCalls(calls)).toEqual(['GET /api/v1/push/public-key'])
  })

  it('on iPhone in Safari: the "install first" help', async () => {
    fakeBrowser({ userAgent: IPHONE, push: false })
    server()
    await initPush()
    expect(pushStatus.value).toBe('install-first')
  })

  it('blocked in the browser settings: says so', async () => {
    fakeBrowser({ permission: 'denied' })
    server()
    await initPush()
    expect(pushStatus.value).toBe('blocked')
  })

  it('already on: sends the subscription again (keys and language up to date)', async () => {
    setLocale('he')
    localStorage.setItem(PUSH_OWNER_KEY, String(ME.id))
    fakeBrowser({ permission: 'granted', existing: subscription() })
    const { calls } = server()
    await initPush()
    expect(pushStatus.value).toBe('on')
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/push/subscriptions')
    expect(post?.body).toEqual({ endpoint: ENDPOINT, keys: { p256dh: 'BROWSER_P256DH', auth: 'BROWSER_AUTH' }, locale: 'he' })
  })

  it('a subscription made with an older key (rotation) is dropped: off, to turn on again', async () => {
    localStorage.setItem(PUSH_OWNER_KEY, String(ME.id))
    const old = subscription(OTHER_KEY)
    fakeBrowser({ permission: 'granted', existing: old })
    const { calls } = server()
    await initPush()
    expect(old.unsubscribe).toHaveBeenCalled()
    expect(pushStatus.value).toBe('off')
    expect(pushCalls(calls)).toEqual(['GET /api/v1/push/public-key'])
  })

  it('someone else turned them on in this browser (a shared device): dropped, never taken over', async () => {
    localStorage.setItem(PUSH_OWNER_KEY, '99')
    const previous = subscription()
    fakeBrowser({ permission: 'granted', existing: previous })
    const { calls } = server()
    await initPush()
    expect(previous.unsubscribe).toHaveBeenCalled()
    expect(pushStatus.value).toBe('off')
    expect(pushCalls(calls)).toEqual(['GET /api/v1/push/public-key'])
    expect(localStorage.getItem(PUSH_OWNER_KEY)).toBeNull()
  })

  it('no service worker (development server): hidden', async () => {
    fakeBrowser({ registration: false })
    server()
    await initPush()
    expect(pushStatus.value).toBe('hidden')
  })
})

describe('enablePush (only from a tap or click)', () => {
  it('asks for permission synchronously, inside the gesture, before anything is awaited', async () => {
    const browser = fakeBrowser()
    server()
    await initPush()

    const pending = enablePush()
    // Safari needs requestPermission() in the gesture's own call stack.
    expect(browser.Notification.requestPermission).toHaveBeenCalledTimes(1)
    await pending
  })

  it('granted: subscribes visibly (userVisibleOnly) with the server key and saves the device', async () => {
    const browser = fakeBrowser()
    const { calls } = server()
    await initPush()
    await enablePush()

    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1)
    const options = browser.pushManager.subscribe.mock.calls[0][0]
    expect(options.userVisibleOnly).toBe(true)
    expect(Array.from(new Uint8Array(options.applicationServerKey))).toEqual(Array.from(KEY_BYTES))
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/v1/push/subscriptions')?.body).toEqual({
      endpoint: ENDPOINT,
      keys: { p256dh: 'BROWSER_P256DH', auth: 'BROWSER_AUTH' },
      locale: 'en',
    })
    expect(pushStatus.value).toBe('on')
    expect(localStorage.getItem(PUSH_OWNER_KEY)).toBe(String(ME.id))
  })

  it('refused: blocked, nothing subscribed', async () => {
    const browser = fakeBrowser({ answer: 'denied' })
    const { calls } = server()
    await initPush()
    await enablePush()
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled()
    expect(pushCalls(calls)).toEqual(['GET /api/v1/push/public-key'])
    expect(pushStatus.value).toBe('blocked')
  })

  it('dismissed: still off', async () => {
    fakeBrowser({ answer: 'default' })
    server()
    await initPush()
    await enablePush()
    expect(pushStatus.value).toBe('off')
  })

  it('the server refused the device: the browser subscription is undone, still off', async () => {
    const browser = fakeBrowser()
    server({ 'POST /api/v1/push/subscriptions': () => ({ status: 422, body: { message: 'invalid' } }) })
    await initPush()
    await enablePush()
    expect(browser.current()?.unsubscribe).toHaveBeenCalled()
    expect(pushStatus.value).toBe('off')
  })
})

describe('turning off, and signing out', () => {
  it('disablePush: DELETE for this endpoint, then unsubscribes the browser', async () => {
    const existing = subscription()
    fakeBrowser({ permission: 'granted', existing })
    const { calls } = server()
    await initPush()
    await disablePush()
    const del = calls.find((c) => c.method === 'DELETE')
    expect(del?.path).toBe('/api/v1/push/subscriptions')
    expect(del?.body).toEqual({ endpoint: ENDPOINT })
    expect(existing.unsubscribe).toHaveBeenCalled()
    expect(pushStatus.value).toBe('off')
  })

  it('forgetPushOnSignOut: DELETE then unsubscribe, even when the server cannot be reached', async () => {
    const existing = subscription()
    fakeBrowser({ permission: 'granted', existing })
    const { calls } = server({ 'DELETE /api/v1/push/subscriptions': () => 'network-error' })
    await forgetPushOnSignOut()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/push/subscriptions')).toBe(true)
    expect(existing.unsubscribe).toHaveBeenCalled()
    expect(pushStatus.value).toBe('hidden')
  })

  it('dropPushLocally (session expired, banned): unsubscribes without calling the server', async () => {
    const existing = subscription()
    fakeBrowser({ permission: 'granted', existing })
    const { calls } = server()
    dropPushLocally()
    await flush()
    expect(existing.unsubscribe).toHaveBeenCalled()
    expect(pushCalls(calls)).toEqual([])
  })

  it('a session that merely expired keeps the notifications (the person did not sign out)', async () => {
    localStorage.setItem(PUSH_OWNER_KEY, String(ME.id))
    const existing = subscription()
    fakeBrowser({ permission: 'granted', existing })
    server()
    endSession('session_expired')
    await flush()
    expect(existing.unsubscribe).not.toHaveBeenCalled()
    expect(localStorage.getItem(PUSH_OWNER_KEY)).toBe(String(ME.id))
  })

  it('a ban unsubscribes the browser', async () => {
    const existing = subscription()
    fakeBrowser({ permission: 'granted', existing })
    server()
    endSession('banned')
    await flush()
    expect(existing.unsubscribe).toHaveBeenCalled()
  })

  it('signing out from the account menu removes this device before ending the session', async () => {
    localStorage.setItem(PUSH_OWNER_KEY, String(ME.id))
    const existing = subscription()
    fakeBrowser({ permission: 'granted', existing })
    const { calls } = server()
    await act(async () => {
      render(<UserMenu />, host)
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.user-menu__signout')!.click()
      await flush()
      await flush()
    })
    expect(pushCalls(calls).filter((c) => c !== 'GET /api/v1/push/public-key' && c !== 'POST /api/v1/push/subscriptions')).toEqual([
      'DELETE /api/v1/push/subscriptions',
      'POST /api/v1/auth/logout',
    ])
    expect(existing.unsubscribe).toHaveBeenCalled()
    expect(session.value.status).toBe('signed-out')
    expect(localStorage.getItem(PUSH_OWNER_KEY)).toBeNull()
  })
})

describe('the test button', () => {
  it('asks the server to push to this account\'s devices', async () => {
    fakeBrowser({ permission: 'granted', existing: subscription() })
    const { calls } = server()
    await initPush()
    expect(await sendTestPush()).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/push/test')).toBe(true)
  })
})

describe('a notification tapped while the app is open', () => {
  it('opens the conversation in the app (in-app paths only)', () => {
    const browser = fakeBrowser()
    const stop = listenForNotificationClicks()
    browser.fromWorker({ type: 'OPEN_URL', url: '/c/12/t/40' })
    expect(route.value).toEqual({ name: 'channel', id: 12, thread: 40 })
    browser.fromWorker({ type: 'OPEN_URL', url: 'https://evil.test/c/1' })
    browser.fromWorker({ type: 'OPEN_URL', url: '/elsewhere' })
    expect(route.value).toEqual({ name: 'channel', id: 12, thread: 40 })
    stop()
  })
})

describe('PushSettings (in the account menu)', () => {
  const mount = async () => {
    await act(async () => {
      render(<PushSettings />, host)
      await flush()
      await flush()
    })
  }

  it('renders nothing when push is off on the server', async () => {
    fakeBrowser()
    server({ 'GET /api/v1/push/public-key': () => ({ status: 404, body: { error: 'push_disabled' } }) })
    await mount()
    expect(host.innerHTML).toBe('')
  })

  it('on iPhone in Safari: explains to install first, no switch', async () => {
    fakeBrowser({ userAgent: IPHONE, push: false })
    server()
    await mount()
    expect(host.textContent).toContain(t('push.installFirst'))
    expect(host.querySelector('input')).toBeNull()
  })

  it('a switch that asks only when tapped, then a test button', async () => {
    const browser = fakeBrowser()
    server()
    await mount()
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(toggle.getAttribute('role')).toBe('switch')
    expect(toggle.checked).toBe(false)
    expect(host.textContent).toContain(t('push.toggle'))
    expect(browser.Notification.requestPermission).not.toHaveBeenCalled()

    await act(async () => {
      toggle.click()
      await flush()
      await flush()
    })
    expect(browser.Notification.requestPermission).toHaveBeenCalledTimes(1)
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
    expect(host.textContent).toContain(t('push.test'))
  })

  it('blocked: says how to allow it again', async () => {
    fakeBrowser({ permission: 'denied' })
    server()
    await mount()
    expect(host.textContent).toContain(t('push.blocked'))
  })

  it('speaks Hebrew', async () => {
    const english = t('push.toggle')
    setLocale('he')
    fakeBrowser()
    server()
    await mount()
    expect(host.textContent).toContain(t('push.toggle'))
    expect(t('push.toggle')).not.toBe(english)
  })
})
