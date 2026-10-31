// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SHELL_URL, activate, handle, precache, routeRequest, type SwDeps } from './sw-core.ts'

const ORIGIN = 'https://slax.example.test'
const PRECACHE = new Set(['/index.html', '/assets/index-abc123.js', '/assets/index-def456.css', '/fonts/cascadia-mono-latin-300.woff2', '/manifest.webmanifest', '/icons/icon-192.png'])

type Shape = { url: string; method?: string; mode?: RequestMode }
const route = ({ url, method = 'GET', mode = 'cors' }: Shape) =>
  routeRequest({ url: url.startsWith('http') ? url : ORIGIN + url, method, mode }, ORIGIN, PRECACHE)

describe('routeRequest: what the service worker answers, and what it leaves alone', () => {
  it.each([
    '/api/v1/me',
    '/api/v1/channels/7/messages?before=12',
    '/api/v1/files/5/download',
    '/auth/google/redirect',
    '/auth/google/callback?code=x&state=y',
    '/auth/e2e/google?state=z',
    '/sanctum/csrf-cookie',
    '/broadcasting/auth',
    '/app/slax-key?protocol=7',
    '/apps/1/events',
    '/up',
    '/healthz',
    '/api',
    '/auth',
  ])('never touches %s, as a fetch or as a navigation', (path) => {
    expect(route({ url: path })).toBe('network')
    expect(route({ url: path, mode: 'navigate' })).toBe('network')
    expect(route({ url: path, method: 'POST' })).toBe('network')
  })

  it.each([
    'https://slax-files.s3.eu-central-1.amazonaws.com/files/1/plan.pdf?X-Amz-Signature=abc',
    'https://challenges.cloudflare.com/turnstile/v0/api.js',
    'https://other.example.test/index.html',
    'http://slax.example.test/assets/index-abc123.js',
    'https://slax.example.test:8443/assets/index-abc123.js',
  ])('never touches another origin: %s', (url) => {
    expect(route({ url })).toBe('network')
    expect(route({ url, mode: 'navigate' })).toBe('network')
    expect(route({ url, mode: 'no-cors' })).toBe('network')
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('leaves %s requests alone, even to the shell files', (method) => {
    expect(route({ url: '/assets/index-abc123.js', method })).toBe('network')
    expect(route({ url: '/channels/general', method, mode: 'navigate' })).toBe('network')
  })

  it("answers the app's own pages (navigations) with the shell", () => {
    expect(route({ url: '/', mode: 'navigate' })).toBe('shell')
    expect(route({ url: '/c/7', mode: 'navigate' })).toBe('shell')
    expect(route({ url: '/c/7/t/12?x=1', mode: 'navigate' })).toBe('shell')
    expect(route({ url: '/admin', mode: 'navigate' })).toBe('shell')
  })

  it('answers the precached build files from the cache', () => {
    expect(route({ url: '/assets/index-abc123.js' })).toBe('precache')
    expect(route({ url: '/assets/index-def456.css' })).toBe('precache')
    expect(route({ url: '/fonts/cascadia-mono-latin-300.woff2', mode: 'cors' })).toBe('precache')
    expect(route({ url: '/manifest.webmanifest' })).toBe('precache')
    expect(route({ url: '/icons/icon-192.png', mode: 'no-cors' })).toBe('precache')
  })

  it('leaves alone any same-origin file it did not precache, and any query string', () => {
    expect(route({ url: '/assets/index-NEWHASH.js' })).toBe('network')
    expect(route({ url: '/assets/index-abc123.js?v=2' })).toBe('network')
    expect(route({ url: '/sw.js' })).toBe('network')
    expect(route({ url: '/robots.txt' })).toBe('network')
  })

  it('does not take a lookalike path for the API', () => {
    expect(route({ url: '/apiary', mode: 'navigate' })).toBe('shell')
    expect(route({ url: '/c/api/', mode: 'navigate' })).toBe('shell')
  })

  it('is case-sensitive like nginx: /API/ is not the API, but it is not precached either', () => {
    expect(route({ url: '/API/v1/me' })).toBe('network')
  })
})

/** CacheStorage in memory: enough of it for the service worker's handlers. */
class FakeCaches {
  readonly stores = new Map<string, Map<string, Response>>()

  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new Map())
    const store = this.stores.get(name)!
    const key = (request: RequestInfo | URL) => new URL(typeof request === 'string' || request instanceof URL ? String(request) : request.url, ORIGIN).pathname
    return {
      put: async (request: RequestInfo | URL, response: Response) => void store.set(key(request), response),
      match: async (request: RequestInfo | URL) => store.get(key(request))?.clone(),
      keys: async () => [...store.keys()].map((path) => new Request(ORIGIN + path)),
    } as unknown as Cache
  }

  async keys() {
    return [...this.stores.keys()]
  }

  async has(name: string) {
    return this.stores.has(name)
  }

  async delete(name: string) {
    return this.stores.delete(name)
  }
}

function deps(fetch: (request: Request) => Promise<Response>): SwDeps & { caches: FakeCaches } {
  return { caches: new FakeCaches(), fetch: vi.fn(fetch) } as unknown as SwDeps & { caches: FakeCaches }
}

const page = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' }, ...init })

describe('precache (install)', () => {
  it('puts every file of the build in the versioned cache, fetched fresh and without cookies', async () => {
    const d = deps(async (request) => page(`body of ${new URL(request.url).pathname}`))
    await precache(d, 'slax-shell-v1', [SHELL_URL, '/assets/index-abc123.js'], ORIGIN)
    const store = d.caches.stores.get('slax-shell-v1')!
    expect([...store.keys()]).toEqual([SHELL_URL, '/assets/index-abc123.js'])
    expect(await store.get(SHELL_URL)!.text()).toBe('body of /index.html')
    const requests = vi.mocked(d.fetch).mock.calls.map(([request]) => request as Request)
    for (const request of requests) {
      expect(request.cache).toBe('reload')
      expect(request.credentials).toBe('omit')
    }
  })

  it('fails the install when a file is missing, and puts nothing (never a half-filled cache)', async () => {
    const d = deps(async (request) => (request.url.endsWith('.js') ? new Response('', { status: 404 }) : page('ok')))
    await expect(precache(d, 'slax-shell-v1', [SHELL_URL, '/assets/index-abc123.js'], ORIGIN)).rejects.toThrow(/index-abc123\.js.*404/)
    expect(d.caches.stores.get('slax-shell-v1')?.size ?? 0).toBe(0)
  })

  it('a refill after a deploy (old files gone from the server) leaves the cache empty, never mixed', async () => {
    // The old worker refills its own list: the new index.html answers, its old bundle is gone.
    const d = deps(async (request) => (request.url.endsWith('.js') ? new Response('', { status: 404 }) : page('index of the NEW version')))
    await expect(precache(d, 'slax-shell-v1', [SHELL_URL, '/assets/index-abc123.js'], ORIGIN)).rejects.toThrow()
    expect(d.caches.stores.get('slax-shell-v1')?.size ?? 0).toBe(0)
  })

  it('a network failure midway puts nothing either', async () => {
    const d = deps(async (request) => {
      if (request.url.endsWith('.js')) throw new TypeError('Failed to fetch')
      return page('ok')
    })
    await expect(precache(d, 'slax-shell-v1', [SHELL_URL, '/assets/index-abc123.js'], ORIGIN)).rejects.toThrow(TypeError)
    expect(d.caches.stores.get('slax-shell-v1')?.size ?? 0).toBe(0)
  })

  it('refuses a redirected response (the shell must be the page itself)', async () => {
    const redirected = page('sign in')
    Object.defineProperty(redirected, 'redirected', { value: true })
    const d = deps(async () => redirected)
    await expect(precache(d, 'slax-shell-v1', [SHELL_URL], ORIGIN)).rejects.toThrow(/redirect/)
  })
})

describe('activate', () => {
  const FILES = [SHELL_URL, '/assets/index-abc123.js']

  it('deletes every cache but the current version (old shells, anything else on the origin)', async () => {
    const d = deps(async () => page('x'))
    for (const name of ['slax-shell-v0', 'slax-shell-v1', 'slax-runtime', 'something-else']) await d.caches.open(name)
    await (await d.caches.open('slax-shell-v1')).put(SHELL_URL, page('cached'))
    await activate(d, 'slax-shell-v1', FILES, ORIGIN)
    expect(await d.caches.keys()).toEqual(['slax-shell-v1'])
    // Its own cache was there: nothing fetched.
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('refills its own cache when it is gone (emptied by a sign-out while this version waited)', async () => {
    const d = deps(async (request) => page(`body of ${new URL(request.url).pathname}`))
    await (await d.caches.open('slax-shell-v0')).put(SHELL_URL, page('old'))
    await activate(d, 'slax-shell-v1', FILES, ORIGIN)
    expect(await d.caches.keys()).toEqual(['slax-shell-v1'])
    expect([...d.caches.stores.get('slax-shell-v1')!.keys()]).toEqual(FILES)
  })

  it('activates anyway when that refill fails (offline): online use does not need the cache', async () => {
    const d = deps(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(activate(d, 'slax-shell-v1', FILES, ORIGIN)).resolves.toBeUndefined()
  })
})

describe('handle (fetch)', () => {
  const navigation = (path: string) => new Request(ORIGIN + path, { mode: 'same-origin' })

  it('navigations go to the network first: online, the newest page is served', async () => {
    const d = deps(async () => page('fresh page'))
    await (await d.caches.open('slax-shell-v1')).put(SHELL_URL, page('cached page'))
    const response = await handle('shell', navigation('/c/7'), d, 'slax-shell-v1')
    expect(await response.text()).toBe('fresh page')
  })

  it('serves the cached shell for a navigation when the network is down', async () => {
    const d = deps(async () => {
      throw new TypeError('Failed to fetch')
    })
    await (await d.caches.open('slax-shell-v1')).put(SHELL_URL, page('cached page'))
    const response = await handle('shell', navigation('/c/7'), d, 'slax-shell-v1')
    expect(await response.text()).toBe('cached page')
  })

  it("passes the server's own error page through (a 502 is not 'offline')", async () => {
    const d = deps(async () => page('bad gateway', { status: 502 }))
    await (await d.caches.open('slax-shell-v1')).put(SHELL_URL, page('cached page'))
    const response = await handle('shell', navigation('/c/7'), d, 'slax-shell-v1')
    expect(response.status).toBe(502)
  })

  it('offline and nothing cached: the network error stands', async () => {
    const d = deps(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(handle('shell', navigation('/'), d, 'slax-shell-v1')).rejects.toThrow(TypeError)
  })

  it('build files come from the cache when there, from the network otherwise (never stored at run time)', async () => {
    const d = deps(async () => new Response('from network'))
    const cache = await d.caches.open('slax-shell-v1')
    await cache.put('/assets/index-abc123.js', new Response('from cache'))
    expect(await (await handle('precache', new Request(ORIGIN + '/assets/index-abc123.js'), d, 'slax-shell-v1')).text()).toBe('from cache')
    expect(await (await handle('precache', new Request(ORIGIN + '/icons/icon-192.png'), d, 'slax-shell-v1')).text()).toBe('from network')
    expect([...d.caches.stores.get('slax-shell-v1')!.keys()]).toEqual(['/assets/index-abc123.js'])
  })

  it('reads only its own version, never an older cache', async () => {
    const d = deps(async () => new Response('from network'))
    await (await d.caches.open('slax-shell-v0')).put('/assets/index-abc123.js', new Response('old'))
    expect(await (await handle('precache', new Request(ORIGIN + '/assets/index-abc123.js'), d, 'slax-shell-v1')).text()).toBe('from network')
  })
})
