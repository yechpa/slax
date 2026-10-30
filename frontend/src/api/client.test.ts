import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred, fakeFetch, type FakeReply } from '../test/fakes.ts'
import { ApiError, holdRequests, onClientEvent, releaseRequests, request, resetClientState, type ClientEvent } from './client.ts'

let events: ClientEvent[]
let off: () => void

beforeEach(() => {
  resetClientState()
  events = []
  off = onClientEvent((event) => events.push(event))
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
})

afterEach(() => {
  off()
  vi.unstubAllGlobals()
})

describe('API client', () => {
  it('fetches the CSRF cookie once, then sends it decoded on state-changing requests only', async () => {
    const server = fakeFetch({ 'GET /api/v1/x': () => ({ body: { ok: 1 } }), 'POST /api/v1/x': () => ({ status: 204 }) })
    vi.stubGlobal('fetch', server.fetch)
    expect(await request('/api/v1/x')).toEqual({ ok: 1 })
    await request('/api/v1/x', { method: 'POST', body: { a: 1 } })
    await request('/api/v1/x', { method: 'POST', body: { a: 2 } })
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/x', 'GET /sanctum/csrf-cookie', 'POST /api/v1/x', 'POST /api/v1/x'])
    expect(server.calls[0].headers['X-XSRF-TOKEN']).toBeUndefined()
    expect(server.calls[2].headers['X-XSRF-TOKEN']).toBe('test+token')
    expect(server.calls[2].headers.Accept).toBe('application/json')
    const init = server.fetch.mock.calls[2][1] as RequestInit
    expect(init.credentials).toBe('include')
  })

  it('refreshes an expired CSRF token (419) and retries once', async () => {
    let attempts = 0
    const server = fakeFetch({ 'POST /api/v1/x': () => (++attempts === 1 ? { status: 419, body: { message: 'CSRF token mismatch.' } } : { body: { ok: true } }) })
    vi.stubGlobal('fetch', server.fetch)
    expect(await request('/api/v1/x', { method: 'POST' })).toEqual({ ok: true })
    expect(server.calls.filter((c) => c.path === '/sanctum/csrf-cookie')).toHaveLength(2)
  })

  it('types errors with stable codes and announces 401, 429 and bans', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'GET /401': () => ({ status: 401, body: { message: 'Unauthenticated.' } }),
        'GET /quiet401': () => ({ status: 401 }),
        'GET /403': () => ({ status: 403, body: { error: 'account_banned' } }),
        'GET /404': () => ({ status: 404, body: { message: 'Not Found' } }),
        'GET /422': () => ({ status: 422, body: { message: 'x', errors: { body: ['too long'] } } }),
        'GET /422code': () => ({ status: 422, body: { error: 'turnstile_failed' } }),
        'GET /429': () => ({ status: 429, body: { message: 'Too Many Attempts.' }, headers: { 'Retry-After': '7' } }),
        'GET /500': () => ({ status: 500, body: { message: 'Server Error' } }),
      }).fetch,
    )
    const fail = (path: string, quiet = false) => request(path, { quiet }).then(() => null, (e: ApiError) => e)

    expect((await fail('/401'))?.code).toBe('unauthenticated')
    expect((await fail('/quiet401', true))?.code).toBe('unauthenticated')
    expect((await fail('/403'))?.code).toBe('account_banned')
    expect((await fail('/404'))?.code).toBe('not_found')
    const invalid = await fail('/422')
    expect(invalid?.code).toBe('validation')
    expect(invalid?.fields).toEqual({ body: ['too long'] })
    expect((await fail('/422code'))?.code).toBe('turnstile_failed')
    const limited = await fail('/429')
    expect([limited?.code, limited?.retryAfter]).toEqual(['rate_limited', 7])
    expect((await fail('/500'))?.code).toBe('server_error')

    expect(events).toEqual([{ type: 'unauthorized' }, { type: 'banned' }, { type: 'rate-limited', retryAfter: 7 }])
  })

  it('reports offline on a network failure and online again on the next answer, but not for an abort', async () => {
    let down = true
    vi.stubGlobal('fetch', fakeFetch({ 'GET /x': () => (down ? 'network-error' : { body: {} }) }).fetch)
    await expect(request('/x')).rejects.toMatchObject({ code: 'network', status: 0 })
    await expect(request('/x')).rejects.toMatchObject({ code: 'network' })
    down = false
    await request('/x')
    expect(events).toEqual([{ type: 'offline' }, { type: 'online' }])

    const controller = new AbortController()
    vi.stubGlobal('fetch', () => {
      controller.abort()
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    })
    await expect(request('/x', { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' })
    expect(events).toHaveLength(2)
  })

  it('builds query strings without empty values', async () => {
    const server = fakeFetch({ 'GET /m': () => ({ body: [] }) })
    vi.stubGlobal('fetch', server.fetch)
    await request('/m', { query: { before: 12, after: undefined, limit: null } })
    expect(server.fetch.mock.calls[0][0]).toBe('/m?before=12')
  })

  describe('held for a sign-out', () => {
    it('refuses every new request without sending it, the sign-out\'s own excepted, until released', async () => {
      const server = fakeFetch({ 'GET /api/v1/x': () => ({ body: { ok: 1 } }), 'POST /api/v1/auth/logout': () => ({ status: 204 }) })
      vi.stubGlobal('fetch', server.fetch)
      await holdRequests()
      await expect(request('/api/v1/x')).rejects.toMatchObject({ code: 'aborted' })
      await expect(request('/api/v1/x', { method: 'POST' })).rejects.toMatchObject({ code: 'aborted' })
      expect(server.calls).toEqual([])

      await request('/api/v1/auth/logout', { method: 'POST', duringSignOut: true })
      expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /sanctum/csrf-cookie', 'POST /api/v1/auth/logout'])
      // Nobody is told about an offline network for a request that never left.
      expect(events).toEqual([])

      releaseRequests()
      expect(await request('/api/v1/x')).toEqual({ ok: 1 })
    })

    it('waits for the requests already on their way before letting the sign-out go on', async () => {
      const slow = deferred<FakeReply>()
      const server = fakeFetch({ 'POST /api/v1/presence/heartbeat': () => slow.promise })
      vi.stubGlobal('fetch', server.fetch)
      document.cookie = 'XSRF-TOKEN=t; path=/'
      const beat = request('/api/v1/presence/heartbeat', { method: 'POST' })
      await Promise.resolve()

      let held = false
      const holding = holdRequests().then(() => (held = true))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(held).toBe(false)
      slow.resolve({ status: 204 })
      await holding
      await beat
      expect(held).toBe(true)
    })

    it('cuts what is still on its way after the wait, and goes on', async () => {
      const fetch = vi.fn(
        (_input: RequestInfo | URL, init: RequestInit = {}) =>
          new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
      )
      vi.stubGlobal('fetch', fetch)
      const hanging = request('/api/v1/presence').catch((error: unknown) => error)
      await Promise.resolve()
      await holdRequests(30)
      expect(await hanging).toMatchObject({ code: 'aborted' })
      expect(events).toEqual([])
    })
  })
})
