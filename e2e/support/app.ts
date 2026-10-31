/**
 * Shared steps of the end-to-end suite: people signed in through the stand-in for Google
 * (each in its own browser context, so its own cookies, storage and socket), the API for
 * setting a scene up quickly, and locators for the parts of the app the tests read.
 */
import { expect, type Browser, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test'
import { FSI, PDI, dirOf, t, type Locale, type Theme } from './i18n.ts'

export const BASE_URL = 'http://localhost'
/** Cloudflare's published always-pass Turnstile test site key (e2e/stack.env). */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA'

let counter = 0
/** A name no other test (or earlier run on the same database) uses: lowercase letters, digits, dashes. */
export function uniq(prefix: string): string {
  counter += 1
  return `${prefix}-${process.pid.toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export type Person = {
  context: BrowserContext
  page: Page
  id: number
  name: string
  email: string
  locale: Locale
  theme: Theme
}

type ContextOptions = { locale?: Locale; theme?: Theme; viewport?: { width: number; height: number } }

/**
 * A browser context for one person: language and theme chosen on this device (as the
 * switchers would store them), no request leaving the stack, and Turnstile answered by a
 * stub that only passes for the test site key the e2e build must carry.
 */
export async function newContext(browser: Browser, { locale = 'en', theme = 'console', viewport }: ContextOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: BASE_URL, ...(viewport ? { viewport } : {}) })
  await context.addInitScript(
    ([lang, look]) => {
      try {
        if (localStorage.getItem('slax.locale') === null) localStorage.setItem('slax.locale', lang)
        if (localStorage.getItem('slax.theme') === null) localStorage.setItem('slax.theme', look)
      } catch {
        // Storage refused: the app falls back to the browser's settings.
      }
    },
    [locale, theme] as const,
  )
  // Hermetic: nothing but the stack itself (registered first, so the Turnstile stub below wins).
  await context.route(
    (url) => url.hostname !== 'localhost' && url.hostname !== 'minio',
    (route) => route.abort('blockedbyclient'),
  )
  await context.route('https://challenges.cloudflare.com/turnstile/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: turnstileStub(TURNSTILE_TEST_SITE_KEY) }),
  )
  return context
}

/** Turnstile's explicit-render API: passes at once for the expected site key, fails for any other. */
function turnstileStub(siteKey: string): string {
  return `window.turnstile = {
    render(container, options) {
      setTimeout(() => options.sitekey === ${JSON.stringify(siteKey)}
        ? options.callback('XXXX.DUMMY.TOKEN.XXXX')
        : options['error-callback']())
      return 'e2e-stub'
    },
    remove() {},
  }`
}

/** "Continue with Google", then the account chooser (the e2e stack's stand-in for Google's consent page). */
export async function signInThroughGoogle(page: Page, { email, name, locale, verified = true }: { email: string; name: string; locale: Locale; verified?: boolean }) {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await page.getByRole('button', { name: t(locale, 'auth.google') }).click()
  await page.waitForURL(/\/auth\/e2e\/google\?/)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Name', { exact: true }).fill(name)
  if (!verified) await page.getByLabel('Email verified').uncheck()
  await page.getByRole('button', { name: 'Continue' }).click()
}

/** A new person, signed in, on the workspace (their first channel open). */
export async function signIn(browser: Browser, name: string, options: ContextOptions = {}): Promise<Person> {
  const locale = options.locale ?? 'en'
  const theme = options.theme ?? 'console'
  const context = await newContext(browser, options)
  const page = await context.newPage()
  const email = `${uniq('user')}@example.test`
  await signInThroughGoogle(page, { email, name, locale })
  await expect(page.getByRole('navigation', { name: t(locale, 'nav.label') })).toBeVisible()
  await expect(page.locator('.shell__main .message-list')).toBeVisible()
  const me = await api(page).get<{ id: number }>('/me')
  return { context, page, id: me.id, name, email, locale, theme }
}

/** The API as this page's user (session cookie and XSRF token), for setting a scene up. */
export function api(page: Page) {
  const context = page.context()
  const request = context.request
  const xsrf = async () => (await context.cookies(BASE_URL)).find((cookie) => cookie.name === 'XSRF-TOKEN')?.value
  const headers = async () => {
    let token = await xsrf()
    if (token === undefined) {
      await request.get(`${BASE_URL}/sanctum/csrf-cookie`, { headers: { Accept: 'application/json', Referer: `${BASE_URL}/` } })
      token = await xsrf()
    }
    return { Accept: 'application/json', Referer: `${BASE_URL}/`, 'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }
  }
  async function call<T>(method: string, path: string, data?: unknown): Promise<T> {
    const response = await request.fetch(`${BASE_URL}/api/v1${path}`, { method, headers: await headers(), ...(data === undefined ? {} : { data }) })
    if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()} ${await response.text()}`)
    return (response.status() === 204 ? undefined : await response.json()) as T
  }
  return {
    get: <T>(path: string) => call<T>('GET', path),
    createChannel: (name: string, kind: 'public' | 'private' = 'public', topic: string | null = null) =>
      call<{ id: number; name: string }>('POST', '/channels', { name, kind, topic }),
    addMember: (channelId: number, userId: number) => call<unknown>('POST', `/channels/${channelId}/members`, { user_id: userId }),
    join: (channelId: number) => call<unknown>('POST', `/channels/${channelId}/join`),
    openConversation: (userIds: number[]) => call<{ id: number }>('POST', '/dms', { user_ids: userIds }),
    postMessage: (channelId: number, body: string, parentId: number | null = null) =>
      call<{ id: number }>('POST', `/channels/${channelId}/messages`, { body, client_id: crypto.randomUUID(), parent_id: parentId }),
    /** The latest page of a channel's messages. */
    messages: async (channelId: number) =>
      (await call<{ data: { id: number; body: string; client_id: string | null }[] }>('GET', `/channels/${channelId}/messages`)).data,
  }
}

/** The parts of the app a test reads, in this person's language. */
export function ui(person: Person) {
  const { page, locale } = person
  const main = page.locator('.shell__main')
  return {
    nav: page.getByRole('navigation', { name: t(locale, 'nav.label') }),
    /** A sidebar entry by its exact label: a room ("general" or "#general") or a conversation (a person's name). */
    navItem: (label: string) =>
      page.locator('.sidebar a.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: new RegExp(`^${FSI}?${escape(label.replace(/^#/, ''))}${PDI}?$`) }) }),
    header: main.locator('.channel-header'),
    log: main.locator('.message-list'),
    composer: main.locator('.shell__footer .composer__input'),
    filePicker: main.locator('.shell__footer input.composer__picker'),
    tray: main.locator('.shell__footer .composer__files'),
    typing: main.locator('.shell__footer .typing'),
    /** Messages of the open channel holding this text (sent: not pending, not failed). */
    message: (text: string) => main.locator('.message-list article.message', { hasText: text }),
    sent: (text: string) => main.locator('.message-list article.message:not(.message--pending):not(.message--failed)', { hasText: text }),
    thread: main.locator('.thread'),
    threadComposer: main.locator('.thread .composer__input'),
    reply: (text: string) => main.locator('.thread .thread__log .message-list__row article.message', { hasText: text }),
    toasts: page.locator('.toast-region--app'),
    userMenu: page.locator('.user-menu__toggle'),
  }
}

/** A person's name as the app isolates it in a conversation's label (FSI…PDI). */
export const isolated = (name: string) => FSI + name + PDI

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Opens a channel from the sidebar (an in-app navigation: no reload). */
export async function openChannel(person: Person, label: string): Promise<void> {
  const view = ui(person)
  await view.navItem(label).click()
  await expect(view.header.locator('.channel-header__name')).toContainText(label)
  await expect(view.log).toHaveAttribute('aria-busy', 'false')
}

/** Types and sends a message with Enter, and waits until the server has it. */
export async function send(person: Person, text: string): Promise<void> {
  const view = ui(person)
  await view.composer.fill(text)
  await view.composer.press('Enter')
  await expect(view.sent(text)).toHaveCount(1)
}

/** Checks the page's language, direction and theme. */
export async function expectLook(page: Page, locale: Locale, theme: Theme): Promise<void> {
  const html = page.locator('html')
  await expect(html).toHaveAttribute('lang', locale)
  await expect(html).toHaveAttribute('dir', dirOf(locale))
  await expect(html).toHaveAttribute('data-theme', theme)
}

/** Every WebSocket frame this page receives, from now on (all its sockets, reconnections included). */
export function recordFrames(page: Page): string[] {
  const frames: string[] = []
  page.on('websocket', (socket) => socket.on('framereceived', (frame) => frames.push(String(frame.payload))))
  return frames
}

/**
 * Puts the page's realtime connection (Reverb, /app/…) behind a switch: `cut()` drops the
 * live sockets and refuses new ones (like a network cut), `resume()` lets them through again.
 * Must be installed before the app connects.
 */
export async function realtimeSwitch(page: Page) {
  let open = true
  const live = new Set<{ client: WebSocketRoute; server: WebSocketRoute }>()
  await page.routeWebSocket(/\/app\//, (client) => {
    if (!open) {
      void client.close({ code: 4100, reason: 'e2e network cut' })
      return
    }
    const pair = { client, server: client.connectToServer() }
    live.add(pair)
    client.onClose(() => live.delete(pair))
  })
  return {
    async cut() {
      open = false
      for (const { client, server } of [...live]) {
        await server.close()
        await client.close({ code: 4100, reason: 'e2e network cut' })
      }
      live.clear()
    },
    resume() {
      open = true
    },
  }
}

/** Reloads the app (e.g. after the scene was set up through the API) and waits for the workspace. */
export async function reload(person: Person): Promise<void> {
  await person.page.reload()
  await expect(ui(person).nav).toBeVisible()
}

/**
 * A public or private room created by `owner` with `others` in it; everyone's app is
 * reloaded once so its channel list has it, then the room is opened. Returns its id and name.
 */
export async function roomWith(owner: Person, others: Person[], kind: 'public' | 'private' = 'public'): Promise<{ id: number; name: string }> {
  const name = uniq(kind === 'public' ? 'live' : 'secret')
  const { id } = await api(owner.page).createChannel(name, kind)
  for (const person of others) {
    if (kind === 'public') await api(person.page).join(id)
    else await api(owner.page).addMember(id, person.id)
  }
  for (const person of [owner, ...others]) {
    await reload(person)
    await openChannel(person, name)
  }
  return { id, name }
}

/** Counts the page's full loads (a reload, a navigation that leaves the app) from now on. */
export function countLoads(page: Page): () => number {
  let loads = 0
  page.on('load', () => (loads += 1))
  return () => loads
}

export async function closeAll(...people: (Person | undefined)[]): Promise<void> {
  await Promise.all(people.map((person) => person?.context.close()))
}

