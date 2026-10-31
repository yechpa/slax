/**
 * Sign-out on a shared device: once it begins, nothing else may reach the server (a presence
 * poll answered after POST /auth/logout used to write the signed-in session back), and the
 * logout goes out only once every request already on its way has come back.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { session } from './store/session.ts'
import { deferred, type FakeReply, type FakeRequest } from './test/fakes.ts'
import { channel } from './test/fixtures.ts'
import { mountApp, plain, settle, type Mounted } from './test/mountApp.tsx'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
})

const general = channel(7, { name: 'general' })

function routes(logout: () => FakeReply | Promise<FakeReply>, heartbeat: () => FakeReply | Promise<FakeReply>) {
  return {
    'GET /api/v1/channels': () => ({ body: [general] }),
    'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
    'POST /api/v1/presence/heartbeat': heartbeat,
    'POST /api/v1/auth/logout': logout,
  }
}

/** What would make presence (and the rest) talk to the server: the page shown again, a key pressed. */
function wakeEverything(): void {
  document.dispatchEvent(new Event('visibilitychange'))
  document.dispatchEvent(new KeyboardEvent('keydown'))
}

async function clickSignOut(host: HTMLElement): Promise<void> {
  host.querySelector<HTMLButtonElement>('.user-menu__toggle')!.click()
  await settle()
  host.querySelector<HTMLButtonElement>('.user-menu__signout')!.click()
}

const line = (c: FakeRequest) => `${c.method} ${c.path}`

describe('sign-out', () => {
  it('starts no request once it begins, and sends the logout only after the ones on their way came back', async () => {
    let slow: ReturnType<typeof deferred<FakeReply>> | null = null
    const logout = deferred<FakeReply>()
    app = await mountApp(
      routes(
        () => logout.promise,
        () => slow?.promise ?? { status: 204 },
      ),
      '/c/7',
    )
    expect(session.value.status).toBe('signed-in')

    // A heartbeat on its way when the person taps Sign out.
    slow = deferred<FakeReply>()
    wakeEverything()
    await settle()
    const inFlight = app.server.calls.length
    expect(app.server.calls.at(-1)?.path).toBe('/api/v1/presence/heartbeat')

    await clickSignOut(app.host)
    await settle()
    // The logout waits for it...
    expect(app.server.calls.slice(inFlight).map(line)).not.toContain('POST /api/v1/auth/logout')
    // ...and nothing new starts meanwhile, whatever happens on the page.
    wakeEverything()
    await settle()
    expect(app.server.calls.slice(inFlight)).toEqual([])

    slow.resolve({ status: 204 })
    await settle()
    expect(app.server.calls.slice(inFlight).map(line)).toEqual(['POST /api/v1/auth/logout'])

    wakeEverything()
    await settle()
    logout.resolve({ status: 204 })
    await settle()
    expect(app.server.calls.slice(inFlight).map(line)).toEqual(['POST /api/v1/auth/logout'])
    expect(session.value.status).toBe('signed-out')
  })

  it('offline, the logout cannot be sent: still signed in, said so, and presence goes on', async () => {
    let offline = false
    app = await mountApp(
      routes(
        () => 'network-error',
        () => (offline ? 'network-error' : { status: 204 }),
      ),
      '/c/7',
    )
    offline = true
    await clickSignOut(app.host)
    await settle()
    // Signing out only here would sign the person back in at the next start online: the
    // session cookie is the server's to end.
    expect(session.value.status).toBe('signed-in')
    expect(plain(app.host.querySelector('.toast--error .toast__text')?.textContent)).toBe('Could not sign out. Please try again.')
    expect(app.host.querySelector<HTMLButtonElement>('.user-menu__signout')!.disabled).toBe(false)

    const before = app.server.calls.length
    offline = false
    wakeEverything()
    await settle()
    expect(app.server.calls.slice(before).map(line)).toContain('POST /api/v1/presence/heartbeat')
  })

  it('a session already gone on the server (401) still ends here', async () => {
    app = await mountApp(
      routes(
        () => ({ status: 401, body: { message: 'Unauthenticated.' } }),
        () => ({ status: 204 }),
      ),
      '/c/7',
    )
    await clickSignOut(app.host)
    await settle()
    expect(session.value.status).toBe('signed-out')
    expect(app.host.textContent).toContain('Google')
  })
})
