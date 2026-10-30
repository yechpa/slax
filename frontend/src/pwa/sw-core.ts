/**
 * What the service worker does, as plain functions (sw.ts only wires them to its events), so
 * every decision is unit-tested without a browser.
 *
 * The rule: the service worker serves the public app shell (index.html and the files of the
 * build, precached at install under a versioned cache name) and nothing else.
 *
 * - The API, sign-in, CSRF cookie, broadcasting auth, Reverb (/app/, /apps/), health checks
 *   and every other origin (presigned S3 file URLs, Turnstile) are never touched: the browser
 *   fetches them as if there were no service worker. Nothing authenticated is ever cached.
 * - Navigations go to the network first, so an online user always gets the newest page (a
 *   deploy is never hidden behind an old shell); the cached shell answers only when the
 *   network is down.
 * - Build files (content-hashed, public) come from the cache, else from the network. Nothing
 *   is added to the cache at run time.
 */

/** Prefix of the shell caches; the full name carries the build's version. */
export const CACHE_PREFIX = 'slax-shell-'
/** The page every navigation is answered with offline. */
export const SHELL_URL = '/index.html'

/** Never answered by the service worker, whatever the method or mode (nginx routes them to PHP / Reverb). */
const NEVER = /^\/(api|auth|sanctum|broadcasting|app|apps)(\/|$)|^\/(up|healthz)$/

/** `network`: not handled (the browser fetches it); `shell`: a page of the app; `precache`: a file of the build. */
export type Route = 'network' | 'shell' | 'precache'

export interface RequestShape {
  url: string
  method: string
  mode: RequestMode
}

export function routeRequest(request: RequestShape, origin: string, precached: ReadonlySet<string>): Route {
  if (request.method !== 'GET') return 'network'
  const url = new URL(request.url)
  if (url.origin !== origin) return 'network'
  if (NEVER.test(url.pathname)) return 'network'
  // Any other same-origin navigation is a page of the app (nginx answers them with index.html).
  // By design this includes a file opened as a page, such as /robots.txt or /sw.js: online it
  // comes from the network as usual; offline it gets the shell, like any unknown route.
  if (request.mode === 'navigate') return 'shell'
  if (url.search === '' && precached.has(url.pathname)) return 'precache'
  return 'network'
}

export interface SwDeps {
  caches: CacheStorage
  fetch: (request: Request) => Promise<Response>
}

/**
 * Install: every file of the build into the version's cache, fetched fresh (not from the HTTP
 * cache) and without cookies (the shell is public: nothing personal can end up in it). Any
 * failure fails the install, so a half-filled cache never becomes the active one.
 */
export async function precache(deps: SwDeps, cacheName: string, urls: readonly string[], origin: string): Promise<void> {
  const cache = await deps.caches.open(cacheName)
  await Promise.all(
    urls.map(async (path) => {
      const response = await deps.fetch(new Request(new URL(path, origin), { cache: 'reload', credentials: 'omit' }))
      if (!response.ok) throw new Error(`precache ${path}: HTTP ${response.status}`)
      if (response.redirected) throw new Error(`precache ${path}: redirected`)
      await cache.put(path, response)
    }),
  )
}

/** Activate: only the current version's cache stays (older shells, anything else on the origin go). */
export async function activate(deps: SwDeps, cacheName: string): Promise<void> {
  const names = await deps.caches.keys()
  await Promise.all(names.filter((name) => name !== cacheName).map((name) => deps.caches.delete(name)))
}

/** The answer to a request routed `shell` or `precache`. */
export async function handle(route: Exclude<Route, 'network'>, request: Request, deps: SwDeps, cacheName: string): Promise<Response> {
  const cache = await deps.caches.open(cacheName)
  // ignoreVary: nginx varies on Accept-Encoding, which a service worker's requests cannot show.
  if (route === 'precache') return (await cache.match(request, { ignoreVary: true })) ?? deps.fetch(request)
  try {
    return await deps.fetch(request)
  } catch (error) {
    // No network at all (an HTTP error from the server is passed through above, not here).
    const shell = await cache.match(SHELL_URL, { ignoreVary: true })
    if (shell) return shell
    throw error
  }
}
