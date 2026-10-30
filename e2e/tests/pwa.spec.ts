/**
 * The installable app (frontend/src/pwa): the e2e build registers its service worker like
 * production does. The shell then opens offline (saying so) and recovers by itself; a new
 * version is announced and taken on request; a sign-out leaves nothing private in Cache
 * Storage; and none of it trips the production Content-Security-Policy.
 */
import { expect, test, type Page } from '@playwright/test'
import { closeAll, newContext, send, signIn, ui, uniq, type Person } from '../support/app.ts'
import { t } from '../support/i18n.ts'

/** The policy slax-web sends (docker/web/entrypoint.sh) for http://localhost with the e2e services. */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self'",
  "img-src 'self' data: http://minio:9000",
  "font-src 'self'",
  "connect-src 'self' ws://localhost",
  'frame-src https://challenges.cloudflare.com',
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ')

/** Waits until the service worker is active and controls this page; returns its script URL. */
async function controlled(page: Page): Promise<string> {
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready
    return navigator.serviceWorker.controller !== null
  })
  return page.evaluate(() => navigator.serviceWorker.controller!.scriptURL)
}

/** Everything in this origin's Cache Storage: each cached URL and its body. */
async function cacheStorage(page: Page): Promise<{ cache: string; url: string; body: string }[]> {
  return page.evaluate(async () => {
    const entries: { cache: string; url: string; body: string }[] = []
    for (const cache of await caches.keys()) {
      const store = await caches.open(cache)
      for (const request of await store.keys()) {
        const response = await store.match(request)
        entries.push({ cache, url: request.url, body: response ? await response.text() : '' })
      }
    }
    return entries
  })
}

const PRIVATE_PATH = /^\/(api|auth|sanctum|broadcasting|app|apps)(\/|$)/

test('the e2e build registers the service worker and is installable, under the production CSP', async ({ browser }) => {
  const context = await newContext(browser)
  try {
    const page = await context.newPage()
    const violations: string[] = []
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.exposeFunction('reportViolation', (text: string) => violations.push(text))
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        ;(window as unknown as { reportViolation: (text: string) => void }).reportViolation(`${event.violatedDirective} ${event.blockedURI}`)
      })
    })
    // The page with slax-web's headers (the e2e proxy does not set them).
    await context.route(
      (url) => url.hostname === 'localhost' && url.pathname === '/',
      async (route) => {
        const response = await route.fetch()
        await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': PRODUCTION_CSP } })
      },
    )

    const response = await page.goto('/')
    expect(response?.headers()['content-security-policy']).toBe(PRODUCTION_CSP)
    await expect(page.getByRole('button', { name: t('en', 'auth.google') })).toBeVisible()
    expect(new URL(await controlled(page)).pathname).toBe('/sw.js')
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
    expect(scope).toBe('http://localhost/')

    // The manifest the page links, with the icons it lists.
    const href = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(href).toBe('/manifest.webmanifest')
    const manifest = await (await page.request.get(href!)).json()
    expect(manifest).toMatchObject({ name: 'Slax', short_name: 'Slax', start_url: '/', scope: '/', display: 'standalone' })
    for (const icon of manifest.icons as { src: string; type: string }[]) {
      const response = await page.request.get(icon.src)
      expect(response.ok(), icon.src).toBe(true)
      expect(response.headers()['content-type']).toBe('image/png')
    }
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png')

    // The shell is precached, and nothing else.
    const cached = await cacheStorage(page)
    const paths = cached.map((entry) => new URL(entry.url).pathname)
    expect(paths).toContain('/index.html')
    expect(paths.some((path) => path.startsWith('/assets/'))).toBe(true)
    expect(paths.filter((path) => PRIVATE_PATH.test(path))).toEqual([])

    expect(violations).toEqual([])
    expect(errors.filter((text) => /Content Security Policy|service ?worker|manifest/i.test(text))).toEqual([])
    // The policy was really enforced (this check is not vacuous): an inline script is refused and reported.
    await page.evaluate(() => {
      const script = document.createElement('script')
      script.textContent = 'window.inlineRan = true'
      document.head.append(script)
    })
    await expect.poll(() => violations).toContainEqual(expect.stringMatching(/^script-src/))
    expect(await page.evaluate(() => (window as unknown as { inlineRan?: boolean }).inlineRan)).toBeUndefined()
  } finally {
    await context.close()
  }
})

test('the shell opens offline after a first visit, says so, and comes back by itself', async ({ browser }) => {
  let person: Person | undefined
  try {
    person = await signIn(browser, `Offline ${uniq('o')}`)
    const { page, context } = person
    await controlled(page)

    await context.setOffline(true)
    // The service worker itself has no network either: the page can only come from its cache.
    const worker = context.serviceWorkers().find((sw) => new URL(sw.url()).pathname === '/sw.js')!
    expect(await worker.evaluate(() => fetch('/healthz').then(() => 'online', () => 'offline'))).toBe('offline')
    const response = await page.reload()
    expect(response?.fromServiceWorker()).toBe(true)
    // The shell came from the cache; the API cannot answer: the offline notice, in the page's language.
    await expect(page.locator('.splash [role="alert"]')).toHaveText(t('en', 'app.offline'))
    await expect(ui(person).nav).toHaveCount(0)

    await context.setOffline(false)
    await expect(ui(person).nav).toBeVisible()
    await expect(page.locator('.shell__main .message-list')).toBeVisible()
    await expect(page.locator('.splash')).toHaveCount(0)
  } finally {
    await closeAll(person)
  }
})

test('a new version is announced, and taken on request (reload)', async ({ browser }) => {
  let person: Person | undefined
  try {
    person = await signIn(browser, `Update ${uniq('u')}`)
    const { page, context } = person
    await controlled(page)
    const banner = page.getByRole('status').filter({ hasText: t('en', 'pwa.update.ready') })
    await expect(banner).toHaveCount(0)
    const [before] = await page.evaluate(() => caches.keys())

    // A deploy: the server now sends another sw.js (docker/nginx/e2e.conf). The page finds it at its next check.
    await context.addCookies([{ name: 'slax_e2e_sw_build', value: 'next', url: 'http://localhost' }])
    await page.evaluate(async () => (await navigator.serviceWorker.ready).update())

    await expect(banner).toBeVisible()
    // Nothing switched behind the page's back: the old worker and its cache still serve it.
    expect(await page.evaluate(async () => ((await navigator.serviceWorker.ready).waiting ? 'waiting' : 'none'))).toBe('waiting')
    expect(await page.evaluate(() => caches.keys())).toContain(before)
    await page.evaluate(() => ((window as unknown as { beforeUpdate: boolean }).beforeUpdate = true))

    await Promise.all([page.waitForEvent('load'), banner.getByRole('button', { name: t('en', 'pwa.update.reload') }).click()])
    // Reloaded (the marker is gone), signed in as before, no banner, on the new version alone.
    expect(await page.evaluate(() => (window as unknown as { beforeUpdate?: boolean }).beforeUpdate)).toBeUndefined()
    await expect(ui(person).nav).toBeVisible()
    await expect(banner).toHaveCount(0)
    expect(await page.evaluate(async () => ((await navigator.serviceWorker.ready).waiting ? 'waiting' : 'none'))).toBe('none')
    await expect.poll(() => page.evaluate(() => caches.keys())).toEqual([expect.stringMatching(/^slax-shell-next[0-9a-f]{16}$/)])
  } finally {
    await closeAll(person)
  }
})

test('sign-out leaves no private data in Cache Storage, and the shell still works offline', async ({ browser }) => {
  let person: Person | undefined
  try {
    person = await signIn(browser, `Leaver ${uniq('l')}`)
    const { page, context } = person
    await controlled(page)
    const secret = `secret ${uniq('s')}`
    await send(person, secret)

    const isPrivate = (entry: { url: string; body: string }) =>
      new URL(entry.url).origin !== 'http://localhost' ||
      PRIVATE_PATH.test(new URL(entry.url).pathname) ||
      [secret, person!.email, person!.name].some((text) => entry.body.includes(text))
    // Never cached, even while signed in.
    expect((await cacheStorage(page)).filter(isPrivate)).toEqual([])
    // Were anything private cached (by some later version, by mistake), sign-out must remove it too.
    await page.evaluate(async (email) => {
      const leftover = await caches.open('slax-leftover')
      await leftover.put('/api/v1/me', new Response(JSON.stringify({ email })))
    }, person.email)
    expect((await cacheStorage(page)).filter(isPrivate)).toHaveLength(1)

    await ui(person).userMenu.click()
    await page.getByRole('button', { name: t('en', 'action.signOut') }).click()
    await expect(page.getByRole('button', { name: t('en', 'auth.google') })).toBeVisible()

    // Emptied at sign-out, then only the public shell is fetched again.
    await expect
      .poll(async () => {
        const entries = await cacheStorage(page)
        return { private: entries.filter(isPrivate), shell: entries.some((entry) => new URL(entry.url).pathname === '/index.html') }
      })
      .toEqual({ private: [], shell: true })

    await context.setOffline(true)
    await page.reload()
    await expect(page.locator('.splash [role="alert"]')).toHaveText(t('en', 'app.offline'))
    await context.setOffline(false)
    await expect(page.getByRole('button', { name: t('en', 'auth.google') })).toBeVisible()
  } finally {
    await closeAll(person)
  }
})
