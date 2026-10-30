/**
 * Test doubles: a fake `fetch` routing requests to handlers (no network), and a fake
 * realtime client implementing the app's `Realtime` interface.
 */
import { signal } from '@preact/signals'
import { vi } from 'vitest'
import type { ConnectionState, EventHandlers, PresenceListener, Realtime } from '../realtime/echo.ts'

export interface FakeRequest {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  headers: Record<string, string>
}

export type FakeReply = { status?: number; body?: unknown; headers?: Record<string, string> } | 'network-error'
export type FakeHandler = (request: FakeRequest) => FakeReply | Promise<FakeReply>

/**
 * `routes` maps "METHOD /path" (exact) to a handler. Unrouted requests answer 404.
 * GET /sanctum/csrf-cookie is answered by default and sets an XSRF-TOKEN cookie.
 */
export function fakeFetch(routes: Record<string, FakeHandler>) {
  const calls: FakeRequest[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost')
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>))
    const request: FakeRequest = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers,
    }
    calls.push(request)
    const handler =
      routes[`${method} ${url.pathname}`] ??
      (url.pathname === '/sanctum/csrf-cookie'
        ? () => {
            document.cookie = 'XSRF-TOKEN=test%2Btoken; path=/'
            return { status: 204 }
          }
        : () => ({ status: 404, body: { message: 'Not Found' } }))
    const reply = await handler(request)
    if (reply === 'network-error') throw new TypeError('Failed to fetch')
    const status = reply.status ?? 200
    const body = reply.body === undefined || status === 204 ? null : JSON.stringify(reply.body)
    return new Response(body, { status, headers: { 'Content-Type': 'application/json', ...reply.headers } })
  })
  return { fetch, calls }
}

/** A promise with its resolve function exposed, to release a fake reply on cue. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Lets pending promise callbacks run (a few microtask turns and one macrotask). */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

export class FakeRealtime implements Realtime {
  readonly state = signal<ConnectionState>('connected')
  readonly subscriptions = new Map<string, { handlers: EventHandlers; onError?: (status: number | null) => void }>()
  readonly presence = new Map<string, PresenceListener>()
  /** Every whisper sent, in order. */
  readonly whispers: { channel: string; event: string; data: unknown }[] = []
  private readonly reconnectListeners = new Set<() => void>()

  whisper(channel: string, event: string, data: unknown) {
    if (this.subscriptions.has(channel)) this.whispers.push({ channel, event, data })
  }

  subscribePresence(name: string, listener: PresenceListener) {
    this.presence.set(name, listener)
    return () => {
      this.presence.delete(name)
    }
  }

  /** A whisper from another member, tagged with their id as Reverb does. */
  emitWhisper(channel: string, event: string, data: unknown, userId: number) {
    this.subscriptions.get(channel)?.handlers[event]?.(data, { user_id: String(userId) })
  }

  subscribe(name: string, handlers: EventHandlers, onError?: (status: number | null) => void) {
    this.subscriptions.set(name, { handlers, onError })
    return () => {
      this.subscriptions.delete(name)
    }
  }

  onReconnect(listener: () => void) {
    this.reconnectListeners.add(listener)
    return () => {
      this.reconnectListeners.delete(listener)
    }
  }

  disconnect() {
    this.state.value = 'disconnected'
  }

  /** Delivers an event as Reverb would. */
  emit(channel: string, event: string, payload: unknown) {
    this.subscriptions.get(channel)?.handlers[event]?.(payload)
  }

  drop() {
    this.state.value = 'disconnected'
  }

  /** The socket is back: listeners run as after a real reconnection. */
  reconnect() {
    this.state.value = 'connected'
    for (const listener of [...this.reconnectListeners]) listener()
  }
}
