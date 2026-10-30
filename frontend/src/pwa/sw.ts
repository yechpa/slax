/**
 * Slax's service worker, served at /sw.js (scope /). Built by plugins/service-worker.ts,
 * which bakes in the precache list and the build's version. This file only wires events to
 * the tested functions of sw-core.ts; read that file for what is (and is never) handled.
 *
 * Updates: a new version installs (precaches) and then waits. It takes over only when the
 * app says so (message SKIP_WAITING, after the person accepted the reload: see register.ts)
 * or once no tab uses the old one, so a page never runs against files it did not load.
 *
 * Web Push (sw-push.ts): every push shows a notification; a tap opens the conversation.
 */
import { CACHE_PREFIX, activate, handle, precache, routeRequest, type SwDeps } from './sw-core.ts'
import { openFromNotification, showPush } from './sw-push.ts'

declare const __SLAX_PRECACHE__: string[]
declare const __SLAX_VERSION__: string

const sw = self as unknown as ServiceWorkerGlobalScope
const CACHE = CACHE_PREFIX + __SLAX_VERSION__
const FILES: readonly string[] = __SLAX_PRECACHE__
const PRECACHED: ReadonlySet<string> = new Set(FILES)
const deps: SwDeps = { caches, fetch: (request) => fetch(request) }

sw.addEventListener('install', (event) => {
  event.waitUntil(precache(deps, CACHE, FILES, sw.location.origin))
})

sw.addEventListener('activate', (event) => {
  // Takes the open pages at once: the first install works offline without a second visit.
  event.waitUntil(activate(deps, CACHE, FILES, sw.location.origin).then(() => sw.clients.claim()))
})

sw.addEventListener('fetch', (event) => {
  const route = routeRequest(event.request, sw.location.origin, PRECACHED)
  // `network`: no respondWith, the browser fetches it as if there were no service worker.
  if (route !== 'network') event.respondWith(handle(route, event.request, deps, CACHE))
})

sw.addEventListener('message', (event) => {
  const type = (event.data as { type?: unknown } | null)?.type
  if (type === 'SKIP_WAITING') void sw.skipWaiting()
  // After a sign-out the app empties Cache Storage; each worker (the active one, and one waiting
  // to take over) fetches its own shell again for offline use.
  if (type === 'PRECACHE') event.waitUntil(precache(deps, CACHE, FILES, sw.location.origin))
})

sw.addEventListener('push', (event) => {
  event.waitUntil(showPush(sw.registration, event.data, sw.location.origin))
})

sw.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: unknown } | null)?.url
  event.waitUntil(openFromNotification(sw.clients, url, sw.location.origin))
})
