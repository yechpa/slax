/**
 * Web Push notifications (frontend/src/pwa/push.ts, backend PushSubscriptionController).
 *
 * The e2e stack has no VAPID keys, like the local stack: push is off, the account menu shows
 * no switch, and sending messages (a DM, a mention, a thread reply: the cases that would notify)
 * works exactly as before.
 *
 * The switch itself is then shown against a stubbed server key and a stubbed browser push
 * service: headless Chromium cannot reach a real push service (and must not), so
 * PushManager.subscribe answers a made-up subscription, and the permission prompt (headless
 * Chromium always says "denied") answers "granted". What is real: the service worker
 * registration, the app's flow and its requests. Delivery to Apple, Google or Mozilla is not tested anywhere (docs/known-limitations.md).
 */
import { generateKeyPairSync } from 'node:crypto'
import { expect, test, type BrowserContext } from '@playwright/test'
import { BASE_URL, api, closeAll, openChannel, reload, send, signIn, ui, uniq, type Person } from '../support/app.ts'
import { t } from '../support/i18n.ts'

/** A VAPID-format public key (a P-256 point, base64url) made for this run; never a deployment's. */
function testPublicKey(): string {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
  return point.toString('base64url')
}

const FAKE_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/e2e-stub-device'

test('without VAPID keys push is off: no switch, the endpoints say so, and messages are sent as before', async ({ browser }) => {
  let alice: Person | undefined
  let bob: Person | undefined
  try {
    alice = await signIn(browser, `Alice ${uniq('p')}`)
    bob = await signIn(browser, `Bob${uniq('p').replace(/-/g, '')}`)

    // The server: 404 push_disabled for the key, the subscription and the test.
    const request = alice.context.request
    const key = await request.get(`${BASE_URL}/api/v1/push/public-key`, { headers: { Accept: 'application/json', Referer: `${BASE_URL}/` } })
    expect(key.status()).toBe(404)
    expect(await key.json()).toEqual({ error: 'push_disabled' })

    // The account menu has no notifications section.
    const view = ui(alice)
    await view.userMenu.click()
    await expect(alice.page.locator('.user-menu__panel')).toBeVisible()
    await expect(alice.page.locator('.user-menu__signout')).toBeVisible()
    await expect(alice.page.locator('.push')).toHaveCount(0)
    await expect(alice.page.getByText(t('en', 'push.toggle'))).toHaveCount(0)
    await alice.page.keyboard.press('Escape')

    // A DM, a mention and a thread reply: each is sent and reaches the other person.
    const dm = await api(alice.page).openConversation([bob.id])
    await reload(alice)
    await alice.page.goto(`/c/${dm.id}`)
    await expect(view.log).toHaveAttribute('aria-busy', 'false')
    await send(alice, 'dinner at eight')
    const room = await api(alice.page).createChannel(uniq('family'))
    await api(bob.page).join(room.id)
    await reload(alice)
    await openChannel(alice, room.name)
    const mention = `@${bob.name.split(' ')[0]} are you coming?`
    await send(alice, mention)
    const parent = await api(bob.page).postMessage(room.id, 'who brings dessert?')
    const reply = await api(alice.page).postMessage(room.id, 'I do', parent.id)
    expect(reply.id).toBeGreaterThan(parent.id)

    expect((await api(bob.page).messages(dm.id)).map((m) => m.body)).toContain('dinner at eight')
    expect((await api(bob.page).messages(room.id)).map((m) => m.body)).toContain(mention)
  } finally {
    await closeAll(alice, bob)
  }
})

/** Stubs the server's key and push endpoints, and the browser's push service; records the calls. */
async function stubPush(context: BrowserContext) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const publicKey = testPublicKey()
  await context.route('**/api/v1/push/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    calls.push({ method: request.method(), path, body: request.postDataJSON() })
    if (path === '/api/v1/push/public-key') return route.fulfill({ json: { public_key: publicKey } })
    if (path === '/api/v1/push/test') return route.fulfill({ status: 202, json: { devices: 1 } })
    return route.fulfill({ status: 204 })
  })
  await context.route('**/api/v1/auth/logout', async (route) => {
    calls.push({ method: 'POST', path: '/api/v1/auth/logout', body: null })
    await route.continue()
  })
  await context.addInitScript((endpoint) => {
    const state = window as unknown as { __pushUnsubscribed?: boolean; __pushSubscribeOptions?: unknown; __permissionAsked?: number }
    // Headless Chromium answers "denied" whatever the context grants: the person's answer is stubbed.
    let permission: NotificationPermission = 'default'
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => permission })
    Notification.requestPermission = async () => {
      state.__permissionAsked = (state.__permissionAsked ?? 0) + 1
      permission = 'granted'
      return permission
    }
    let current: PushSubscription | null = null
    PushManager.prototype.getSubscription = async () => current
    PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
      state.__pushSubscribeOptions = { userVisibleOnly: options?.userVisibleOnly, keyLength: (options?.applicationServerKey as Uint8Array).length }
      const applicationServerKey = new Uint8Array(options?.applicationServerKey as Uint8Array).buffer
      current = {
        endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey },
        getKey: () => null,
        toJSON: () => ({ endpoint, keys: { p256dh: 'BE2E-stub-p256dh', auth: 'e2e-stub-auth' } }),
        unsubscribe: async () => {
          state.__pushUnsubscribed = true
          current = null
          return true
        },
      } as unknown as PushSubscription
      return current
    }
  }, FAKE_ENDPOINT)
  return { calls, publicKey }
}

test('with a server key, the switch appears; on subscribes this device, sign-out removes it (push service stubbed)', async ({ browser }) => {
  const person = await signIn(browser, `Ada ${uniq('p')}`)
  try {
    // Installed after sign-in, effective from the reload (init scripts run on every new page load).
    const { calls } = await stubPush(person.context)
    await reload(person)
    const page = person.page
    const view = ui(person)
    await page.waitForFunction(async () => (await navigator.serviceWorker.ready) !== null)

    await view.userMenu.click()
    const toggle = page.getByRole('switch', { name: t('en', 'push.toggle') })
    await expect(toggle).toBeVisible()
    await expect(toggle).not.toBeChecked()
    await expect(page.getByText(t('en', 'push.hint'))).toBeVisible()
    // Nothing was asked or sent on opening.
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
    expect(await page.evaluate(() => (window as unknown as { __permissionAsked?: number }).__permissionAsked ?? 0)).toBe(0)

    await toggle.click()
    await expect(toggle).toBeChecked()
    expect(await page.evaluate(() => (window as unknown as { __permissionAsked?: number }).__permissionAsked)).toBe(1)
    const subscribed = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/push/subscriptions')
    expect(subscribed?.body).toEqual({ endpoint: FAKE_ENDPOINT, keys: { p256dh: 'BE2E-stub-p256dh', auth: 'e2e-stub-auth' }, locale: 'en' })
    expect(await page.evaluate(() => (window as unknown as { __pushSubscribeOptions: unknown }).__pushSubscribeOptions)).toEqual({ userVisibleOnly: true, keyLength: 65 })

    await page.getByRole('button', { name: t('en', 'push.test') }).click()
    await expect(view.toasts).toContainText(t('en', 'push.testSent'))

    await page.locator('.user-menu__signout').click()
    await expect(page.getByRole('button', { name: t('en', 'auth.google') })).toBeVisible()
    const order = calls.filter((c) => c.path === '/api/v1/auth/logout' || c.method === 'DELETE').map((c) => `${c.method} ${c.path}`)
    expect(order).toEqual(['DELETE /api/v1/push/subscriptions', 'POST /api/v1/auth/logout'])
    expect(calls.find((c) => c.method === 'DELETE')?.body).toEqual({ endpoint: FAKE_ENDPOINT })
    expect(await page.evaluate(() => (window as unknown as { __pushUnsubscribed?: boolean }).__pushUnsubscribed)).toBe(true)
  } finally {
    await closeAll(person)
  }
})
