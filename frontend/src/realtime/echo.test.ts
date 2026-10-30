import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientState } from '../api/client.ts'
import { fakeFetch, flush } from '../test/fakes.ts'

/** A stand-in for pusher-js: records options, exposes the connection's state_change. */
const pusher = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  stateListeners: [] as ((change: { previous: string; current: string }) => void)[],
  channels: new Map<string, { bound: Map<string, (data: unknown) => void> }>(),
  unsubscribed: [] as string[],
}))

vi.mock('pusher-js', () => ({
  default: class {
    connection = {
      state: 'initialized',
      bind: (_event: string, listener: (change: { previous: string; current: string }) => void) => pusher.stateListeners.push(listener),
    }
    constructor(_key: string, options: Record<string, unknown>) {
      pusher.options = options
    }
    subscribe(name: string) {
      const channel = {
        bound: new Map<string, (data: unknown) => void>(),
        bind(event: string, handler: (data: unknown) => void) {
          this.bound.set(event, handler)
        },
        unbind(event: string) {
          this.bound.delete(event)
        },
      }
      pusher.channels.set(name, channel)
      return channel
    }
    unsubscribe(name: string) {
      pusher.unsubscribed.push(name)
    }
    disconnect() {}
  },
}))

const { connectRealtime, toConnectionState } = await import('./echo.ts')

const setState = (current: string) => pusher.stateListeners.forEach((listener) => listener({ previous: '', current }))

beforeEach(() => {
  resetClientState()
  pusher.stateListeners = []
  pusher.channels.clear()
  pusher.unsubscribed = []
})

afterEach(() => vi.unstubAllGlobals())

describe('realtime', () => {
  it('maps the six pusher-js states onto three', () => {
    expect(['initialized', 'connecting', 'connected', 'unavailable', 'failed', 'disconnected'].map(toConnectionState)).toEqual([
      'connecting',
      'connecting',
      'connected',
      'disconnected',
      'disconnected',
      'disconnected',
    ])
  })

  it('connects to /app on the page origin and authorizes through the API client (cookie + XSRF)', async () => {
    const server = fakeFetch({ 'POST /broadcasting/auth': () => ({ body: { auth: 'key:sig', channel_data: '{"user_id":"1"}' } }) })
    vi.stubGlobal('fetch', server.fetch)
    await connectRealtime('app-key')
    expect(pusher.options).toMatchObject({ wsHost: location.hostname, enabledTransports: ['ws', 'wss'], disableStats: true })

    const authorize = (pusher.options!.channelAuthorization as { customHandler: (p: object, cb: (e: Error | null, d: unknown) => void) => void }).customHandler
    const callback = vi.fn()
    authorize({ socketId: '1.2', channelName: 'private-channel.7' }, callback)
    await flush()
    expect(callback).toHaveBeenCalledWith(null, { auth: 'key:sig', channel_data: '{"user_id":"1"}' })
    const auth = server.calls.find((c) => c.path === '/broadcasting/auth')!
    expect(auth.body).toEqual({ socket_id: '1.2', channel_name: 'private-channel.7' })
    expect(auth.headers['X-XSRF-TOKEN']).toBe('test+token')
  })

  it('reports a refused subscription with its status and unsubscribes cleanly', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'POST /broadcasting/auth': () => ({ status: 403, body: { message: 'Forbidden' } }) }).fetch)
    const realtime = await connectRealtime('app-key')
    const onError = vi.fn()
    const handler = vi.fn()
    const unsubscribe = realtime.subscribe('private-channel.9', { 'message.created': handler }, onError)

    const authorize = (pusher.options!.channelAuthorization as { customHandler: (p: object, cb: (e: Error | null) => void) => void }).customHandler
    const callback = vi.fn()
    authorize({ socketId: '1.2', channelName: 'private-channel.9' }, callback)
    await flush()
    expect(callback.mock.calls[0][0]).toBeInstanceOf(Error)
    pusher.channels.get('private-channel.9')!.bound.get('pusher:subscription_error')!({ type: 'AuthError' })
    expect(onError).toHaveBeenCalledWith(403)

    pusher.channels.get('private-channel.9')!.bound.get('message.created')!({ id: 1 })
    expect(handler).toHaveBeenCalledWith({ id: 1 })
    unsubscribe()
    expect(pusher.unsubscribed).toEqual(['private-channel.9'])
    expect(pusher.channels.get('private-channel.9')!.bound.size).toBe(0)
  })

  it('exposes the state as a signal and calls onReconnect only when the connection comes back', async () => {
    vi.stubGlobal('fetch', fakeFetch({}).fetch)
    const realtime = await connectRealtime('app-key')
    const reconnected = vi.fn()
    realtime.onReconnect(reconnected)
    expect(realtime.state.value).toBe('connecting')

    setState('connected')
    expect(realtime.state.value).toBe('connected')
    expect(reconnected).not.toHaveBeenCalled()

    setState('unavailable')
    expect(realtime.state.value).toBe('disconnected')
    setState('connecting')
    setState('connected')
    expect(reconnected).toHaveBeenCalledOnce()
  })
})
