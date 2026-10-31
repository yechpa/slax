/**
 * Web Push on this device: the "Notifications on this device" switch in the account menu
 * (PushSettings), and what sign-out must undo. The service worker shows the notifications
 * (sw-push.ts); the server decides who gets one and never sends a message's text.
 *
 * - The server has no VAPID keys (dev, e2e, a deployment without them): GET /push/public-key
 *   is a 404 and nothing is shown.
 * - iPhone and iPad: Safari has push only in the installed app (iOS 16.4+), so outside it the
 *   menu explains to install first. A browser without the Push API shows nothing.
 * - Permission is asked only when the person turns the switch on: `enablePush` must be called
 *   from that tap or click, and calls `Notification.requestPermission()` before anything else
 *   (Safari wants it in the gesture's own call stack). Nothing ever asks by itself.
 * - Each time the app opens, an existing subscription is sent again (upsert: fresh keys, the
 *   current language). One made with an older server key (a rotation) is dropped: the switch
 *   shows off, to turn on again.
 * - Sign-out removes this device from the account (DELETE) and unsubscribes the browser, so a
 *   shared family device stops showing the previous person's notifications; offline, neither
 *   happens (the sign-out itself fails, notifications keep working). A ban unsubscribes
 *   the browser (the server already deleted the account's devices).
 * - A session that merely expired (14 days unused, see config/session.php) keeps
 *   the subscription: the person did not sign out, and losing notifications each time would make
 *   them useless. Who turned them on is remembered on the device (PUSH_OWNER_KEY): if someone
 *   else signs in here, the previous person's subscription is dropped, never taken over.
 */
import { signal } from '@preact/signals'
import { isApiError } from '../api/client.ts'
import { api } from '../api/endpoints.ts'
import { getLocale, t } from '../i18n/index.ts'
import { readPref, removePref, writePref } from '../lib/prefs.ts'
import { navigate, parseRoute } from '../router.ts'
import { me } from '../store/session.ts'
import { showToast } from '../store/ui.ts'
import { isIos, isStandalone } from './install.ts'

/** hidden: nothing to show; install-first: the iOS help; blocked: denied in the browser's settings. */
export type PushStatus = 'hidden' | 'install-first' | 'blocked' | 'off' | 'on'

export const pushStatus = signal<PushStatus>('hidden')
/** Turning on or off is under way (the switch waits). */
export const pushBusy = signal(false)

let publicKey: string | null = null
/** Bumped by sign-out and resets: an initPush still running then changes nothing. */
let generation = 0
/** How long the app waits for a service worker still installing (first visit). */
const READY_WAIT_MS = 10_000
/** The id of the account that turned notifications on in this browser. */
export const PUSH_OWNER_KEY = 'slax.pushOwner'

const myId = () => {
  const id = me.peek()?.id
  return id === undefined ? null : String(id)
}

export function pushSupport(): 'unsupported' | 'install-first' | 'supported' {
  if (isIos() && !isStandalone()) return 'install-first'
  const scope = globalThis as { PushManager?: unknown; Notification?: unknown }
  if (!scope.PushManager || !scope.Notification || !globalThis.navigator?.serviceWorker) return 'unsupported'
  return 'supported'
}

/** The registration that receives the pushes; waits a little for one still installing. */
async function registration(wait = true): Promise<ServiceWorkerRegistration | null> {
  const container = globalThis.navigator?.serviceWorker
  if (!container) return null
  try {
    const found = await container.getRegistration('/')
    if (found || !wait || !container.ready) return found ?? null
    return await Promise.race([container.ready, new Promise<null>((resolve) => setTimeout(() => resolve(null), READY_WAIT_MS))])
  } catch {
    return null
  }
}

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

function sameKey(subscription: PushSubscription, key: string): boolean {
  const used = subscription.options?.applicationServerKey
  if (!used) return false
  const a = new Uint8Array(used)
  const b = keyBytes(key)
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

async function save(subscription: PushSubscription): Promise<void> {
  const keys = subscription.toJSON().keys ?? {}
  await api.push.subscribe({ endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh ?? '', auth: keys.auth ?? '' }, locale: getLocale() })
}

/** When the account menu appears: what the switch shows. Never asks for permission. */
export async function initPush(): Promise<void> {
  const run = ++generation
  let key: string
  try {
    key = (await api.push.publicKey()).public_key
  } catch {
    if (run === generation) pushStatus.value = 'hidden'
    return
  }
  if (run !== generation) return
  publicKey = key
  const support = pushSupport()
  if (support !== 'supported') {
    pushStatus.value = support === 'install-first' ? 'install-first' : 'hidden'
    return
  }
  if (globalThis.Notification?.permission === 'denied') {
    pushStatus.value = 'blocked'
    return
  }
  const found = await registration()
  if (run !== generation) return
  if (!found) {
    pushStatus.value = 'hidden'
    return
  }
  const existing = await found.pushManager.getSubscription().catch(() => null)
  if (run !== generation) return
  if (!existing || globalThis.Notification?.permission !== 'granted') {
    pushStatus.value = 'off'
    return
  }
  // Someone else's (a shared device), or made with an older key (a rotation): dropped, never taken over.
  if (readPref(PUSH_OWNER_KEY) !== myId() || !sameKey(existing, key)) {
    await existing.unsubscribe().catch(() => false)
    removePref(PUSH_OWNER_KEY)
    if (run === generation) pushStatus.value = 'off'
    return
  }
  pushStatus.value = 'on'
  await save(existing).catch(() => undefined)
}

/**
 * Turns notifications on. Call it from the tap or click on the switch only: the permission
 * request is the first thing it does, synchronously.
 */
export function enablePush(): Promise<void> {
  const key = publicKey
  const NotificationApi = globalThis.Notification
  if (!key || !NotificationApi) return Promise.resolve()
  const asked = NotificationApi.requestPermission()
  return finishEnabling(asked, key)
}

async function finishEnabling(asked: Promise<NotificationPermission>, key: string): Promise<void> {
  pushBusy.value = true
  try {
    const permission = await asked.catch(() => 'default' as NotificationPermission)
    if (permission !== 'granted') {
      pushStatus.value = permission === 'denied' ? 'blocked' : 'off'
      return
    }
    const found = await registration()
    let subscription: PushSubscription | null = null
    try {
      subscription = found ? await found.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }) : null
      if (!subscription) throw new Error('no service worker')
      await save(subscription)
      const owner = myId()
      if (owner) writePref(PUSH_OWNER_KEY, owner)
    } catch {
      await subscription?.unsubscribe().catch(() => false)
      pushStatus.value = 'off'
      showToast({ tone: 'error', key: 'push', text: t('push.failed') })
      return
    }
    pushStatus.value = 'on'
  } finally {
    pushBusy.value = false
  }
}

/** Turns notifications off on this device: removed from the account, then from the browser. */
export async function disablePush(): Promise<void> {
  pushBusy.value = true
  try {
    const subscription = await (await registration(false))?.pushManager.getSubscription().catch(() => null)
    if (subscription) {
      // Unreachable server: the browser forgets it anyway, and the push service's 410 removes it later.
      await api.push.unsubscribe(subscription.endpoint).catch(() => undefined)
      await subscription.unsubscribe().catch(() => false)
    }
    removePref(PUSH_OWNER_KEY)
    pushStatus.value = 'off'
  } finally {
    pushBusy.value = false
  }
}

/** The language changed: the device's notifications follow. */
export async function refreshPush(): Promise<void> {
  if (pushStatus.peek() !== 'on') return
  const subscription = await (await registration(false))?.pushManager.getSubscription().catch(() => null)
  if (subscription) await save(subscription).catch(() => undefined)
}

/**
 * Sign-out, before the session ends: this device leaves the account (at most `timeoutMs`).
 * Push off on the server (no key was ever given to this page): nothing to do, and nothing is
 * awaited, so sign-out goes out at once. Returns false, with everything left as it was, when
 * the server could not be told (offline, an error, too slow).
 */
export async function forgetPushOnSignOut(timeoutMs = 3000): Promise<boolean> {
  generation++
  if (publicKey === null) {
    pushStatus.value = 'hidden'
    return true
  }
  // The browser is unsubscribed only once the server has forgotten the device: offline, the
  // sign-out fails too, and the person must stay signed in with notifications still working.
  // (A logout that does go through drops the browser's subscription anyway: endSession.)
  const work = (async () => {
    const subscription = await (await registration(false))?.pushManager.getSubscription().catch(() => null)
    if (!subscription) return true
    // Part of the sign-out: it goes out while every other request is held.
    const forgotten = await api.push.unsubscribe(subscription.endpoint, true).then(
      () => true,
      (error: unknown) => isApiError(error, 'not_found'),
    )
    if (forgotten) await subscription.unsubscribe().catch(() => false)
    return forgotten
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const forgotten = await Promise.race([work.catch(() => false), new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)))])
  clearTimeout(timer)
  if (!forgotten) return false
  removePref(PUSH_OWNER_KEY)
  publicKey = null
  pushStatus.value = 'hidden'
  return true
}

/** A ban (or a sign-out that could not finish): the browser stops receiving. No server call. */
export function dropPushLocally(): void {
  generation++
  removePref(PUSH_OWNER_KEY)
  publicKey = null
  pushStatus.value = 'hidden'
  void (async () => {
    const subscription = await (await registration(false))?.pushManager.getSubscription()
    await subscription?.unsubscribe()
  })().catch(() => undefined)
}

/** The test button. Returns whether the server took it. */
export async function sendTestPush(): Promise<boolean> {
  try {
    await api.push.test()
    showToast({ tone: 'success', key: 'push-test', text: t('push.testSent') })
    return true
  } catch {
    showToast({ tone: 'error', key: 'push-test', text: t('push.testFailed') })
    return false
  }
}

/**
 * A notification tapped while the app is open: the service worker focuses this window and
 * posts OPEN_URL; the app goes there without a reload. In-app paths only. Returns the cleanup.
 */
export function listenForNotificationClicks(container: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker): () => void {
  if (!container) return () => undefined
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null
    if (data?.type !== 'OPEN_URL' || typeof data.url !== 'string' || !data.url.startsWith('/') || data.url.startsWith('//')) return
    const url = new URL(data.url, location.origin)
    if (url.origin !== location.origin || parseRoute(url.pathname).name === 'unknown') return
    navigate(url.pathname)
  }
  container.addEventListener('message', onMessage)
  return () => container.removeEventListener('message', onMessage)
}

/** Forgets everything (tests). */
export function resetPush(): void {
  generation++
  publicKey = null
  pushStatus.value = 'hidden'
  pushBusy.value = false
}
