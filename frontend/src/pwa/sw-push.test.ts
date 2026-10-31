// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { FALLBACK_TITLE, ICON, noticeFromPush, openFromNotification, safeAppPath, showPush, type WindowLike } from './sw-push.ts'

const ORIGIN = 'https://slax.example.test'

/** A push event's data (PushMessageData): json() parses the decrypted text, and throws on bad JSON. */
const data = (value: unknown) => ({
  json: () => (typeof value === 'string' ? JSON.parse(value) : value),
})

const PAYLOAD = { type: 'dm', title: 'Alice (direct message)', body: 'New message', url: '/c/12', tag: 'channel-12' }

describe('safeAppPath: only a path of this app is ever opened', () => {
  it.each([
    ['/c/12', '/c/12'],
    ['/c/12/t/40', '/c/12/t/40'],
    ['/', '/'],
    ['/c/12?x=1#m', '/c/12?x=1#m'],
  ])('keeps %s', (url, expected) => {
    expect(safeAppPath(url, ORIGIN)).toBe(expected)
  })

  it.each([
    'https://evil.test/c/12',
    '//evil.test/c/12',
    '/\\evil.test',
    '\\\\evil.test',
    'javascript:alert(1)',
    'data:text/html,hi',
    'c/12',
    `${ORIGIN}/c/12`,
    '',
    null,
    undefined,
    42,
    { url: '/c/1' },
  ])('refuses %s', (url) => {
    expect(safeAppPath(url, ORIGIN)).toBeNull()
  })
})

describe('noticeFromPush: what the notification shows', () => {
  it('shows the title and the generic line, keeps the in-app path and collapses by conversation', () => {
    const notice = noticeFromPush(data(PAYLOAD), ORIGIN)
    expect(notice.title).toBe('Alice (direct message)')
    expect(notice.options).toEqual({ body: 'New message', tag: 'channel-12', icon: ICON, badge: ICON, data: { url: '/c/12' } })
  })

  it('drops a URL that is not a path of this app', () => {
    expect(noticeFromPush(data({ ...PAYLOAD, url: 'https://evil.test/' }), ORIGIN).options.data).toEqual({ url: null })
  })

  it.each([
    ['no data', null],
    ['not JSON', data('{not json')],
    ['not an object', data('"hello"')],
    ['an array', data([1, 2])],
    ['no title', data({ body: 'x' })],
    ['a title that is not text', data({ title: 7, body: 'x' })],
  ])('still shows something (%s): a push must always become a notification', (_, value) => {
    const notice = noticeFromPush(value, ORIGIN)
    expect(notice.title).toBe(FALLBACK_TITLE)
    expect(notice.options.data).toEqual({ url: null })
  })

  it('cuts overlong texts', () => {
    const notice = noticeFromPush(data({ ...PAYLOAD, title: 'x'.repeat(500), body: 'y'.repeat(500), tag: 'z'.repeat(500) }), ORIGIN)
    expect(notice.title).toHaveLength(120)
    expect(notice.options.body).toHaveLength(200)
    expect(notice.options.tag).toHaveLength(64)
  })
})

describe('showPush (the push event)', () => {
  it('always calls showNotification, once (userVisibleOnly)', async () => {
    for (const value of [data(PAYLOAD), null, data('{broken'), { json: () => { throw new Error('decrypt') } }]) {
      const registration = { showNotification: vi.fn(async () => undefined) }
      await showPush(registration, value, ORIGIN)
      expect(registration.showNotification).toHaveBeenCalledTimes(1)
    }
  })
})

function windowClient(url: string, focused = false): WindowLike & { focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> } {
  const client = {
    url,
    focused,
    focus: vi.fn(async () => client),
    postMessage: vi.fn(),
  }
  return client
}

function clientsWith(...windows: WindowLike[]) {
  return {
    matchAll: vi.fn(async () => windows),
    openWindow: vi.fn(async () => null),
  }
}

describe('openFromNotification (the notificationclick event)', () => {
  it('focuses an open window of the app and asks it to show the conversation', async () => {
    const other = windowClient('https://elsewhere.test/')
    const background = windowClient(`${ORIGIN}/c/3`)
    const focused = windowClient(`${ORIGIN}/c/5`, true)
    const clients = clientsWith(other, background, focused)

    await openFromNotification(clients, '/c/12/t/40', ORIGIN)

    expect(clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true })
    expect(focused.focus).toHaveBeenCalled()
    expect(focused.postMessage).toHaveBeenCalledWith({ type: 'OPEN_URL', url: '/c/12/t/40' })
    expect(background.focus).not.toHaveBeenCalled()
    expect(other.focus).not.toHaveBeenCalled()
    expect(clients.openWindow).not.toHaveBeenCalled()
  })

  it('opens the conversation when no window of the app is open', async () => {
    const clients = clientsWith(windowClient('https://elsewhere.test/'))

    await openFromNotification(clients, '/c/12', ORIGIN)

    expect(clients.openWindow).toHaveBeenCalledWith('/c/12')
  })

  it('ignores a URL that is not a path of this app: focus only, or the app\'s start', async () => {
    const open = windowClient(`${ORIGIN}/c/3`)
    const withWindow = clientsWith(open)
    await openFromNotification(withWindow, 'https://evil.test/phish', ORIGIN)
    expect(open.focus).toHaveBeenCalled()
    expect(open.postMessage).not.toHaveBeenCalled()

    const without = clientsWith()
    await openFromNotification(without, '//evil.test/phish', ORIGIN)
    expect(without.openWindow).toHaveBeenCalledWith('/')
  })
})
