/**
 * The service worker's registration, and the update flow (Review focus: an old app must never
 * keep running unnoticed against a newer API).
 *
 * - Registered only by the production and end-to-end builds (never Vite's dev server, the
 *   tests or the design-system build): `/sw.js`, scope `/`, script always revalidated.
 * - A new version (any change to the build changes sw.js) installs in the background and
 *   waits. The page offers a reload (`updateReady`, UpdateBanner); on yes, the waiting worker
 *   is told SKIP_WAITING and the page reloads once it has taken over.
 * - The browser looks for a new sw.js on every navigation; an installed app can stay open for
 *   days, so the page also asks when it comes back to the foreground, and every hour.
 *
 * Even before the reload, navigations are answered network-first (sw-core.ts): a reload, by
 * the banner or by hand, always gets the newest page.
 */
import { signal } from '@preact/signals'

/** A new version is ready: this page runs the old files until it reloads. */
export const updateReady = signal(false)

/** Production and e2e builds only (`vite build`, `vite build --mode e2e`). */
const ENABLED = import.meta.env.PROD && (import.meta.env.MODE === 'production' || import.meta.env.MODE === 'e2e')
const CHECK_EVERY_MS = 60 * 60 * 1000
/** If the new worker never takes over, reload all the same (the newest page comes from the network). */
const RELOAD_FALLBACK_MS = 3000

export interface RegisterOptions {
  enabled?: boolean
  container?: ServiceWorkerContainer
  reload?: () => void
  checkEveryMs?: number
}

let registration: ServiceWorkerRegistration | null = null
let reloadPage: () => void = () => globalThis.location.reload()
let reloadRequested = false
let cleanups: (() => void)[] = []

export async function registerServiceWorker(options: RegisterOptions = {}): Promise<ServiceWorkerRegistration | null> {
  const enabled = options.enabled ?? ENABLED
  const container = 'container' in options ? options.container : globalThis.navigator?.serviceWorker
  if (!enabled || !container) return null
  if (options.reload) reloadPage = options.reload

  // A first install takes the page too (clients.claim): that change of controller is not an update.
  let controlled = Boolean(container.controller)
  const onControllerChange = () => {
    if (!controlled) {
      controlled = true
      return
    }
    if (reloadRequested) reloadPage()
    // Another tab accepted the update: this page still runs the old files.
    else updateReady.value = true
  }
  container.addEventListener('controllerchange', onControllerChange)
  cleanups.push(() => container.removeEventListener('controllerchange', onControllerChange))

  try {
    registration = await container.register('/sw.js', { scope: '/', updateViaCache: 'none' })
  } catch {
    // Refused (private mode, storage off…): the app works without it, online only.
    return null
  }
  const current = registration

  const offerIfWaiting = (worker: ServiceWorker | null) => {
    if (worker?.state === 'installed' && container.controller) updateReady.value = true
  }
  offerIfWaiting(current.waiting)
  const onUpdateFound = () => {
    const worker = current.installing
    worker?.addEventListener('statechange', () => offerIfWaiting(worker))
  }
  current.addEventListener('updatefound', onUpdateFound)

  const check = () => void current.update().catch(() => undefined)
  const onVisible = () => {
    if (document.visibilityState === 'visible') check()
  }
  document.addEventListener('visibilitychange', onVisible)
  const timer = setInterval(check, options.checkEveryMs ?? CHECK_EVERY_MS)
  cleanups.push(() => {
    current.removeEventListener('updatefound', onUpdateFound)
    document.removeEventListener('visibilitychange', onVisible)
    clearInterval(timer)
  })
  return current
}

/** The person accepted the update: switch to the new version and reload. */
export function applyUpdate(): void {
  reloadRequested = true
  const waiting = registration?.waiting
  if (!waiting) {
    reloadPage()
    return
  }
  waiting.postMessage({ type: 'SKIP_WAITING' })
  setTimeout(() => reloadPage(), RELOAD_FALLBACK_MS)
}

/** The registration, for sign-out (clearAppCaches) and tests. */
export const currentRegistration = () => registration

/** Forgets everything (tests). */
export function resetServiceWorker(): void {
  cleanups.forEach((cleanup) => cleanup())
  cleanups = []
  registration = null
  reloadRequested = false
  reloadPage = () => globalThis.location.reload()
  updateReady.value = false
}
