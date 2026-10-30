/**
 * Realtime over Laravel Reverb, which speaks the Pusher protocol. The browser reaches it
 * on the page's own origin at /app (nginx forwards /app and /apps to Reverb), so no host,
 * port or TLS setting is configured: they follow the page.
 *
 * Private channels are authorized through the app's fetch wrapper (session cookie +
 * X-XSRF-TOKEN), not pusher-js's own XHR. Reconnection and its exponential backoff are
 * pusher-js's; this module exposes the connection state as a signal and an `onReconnect`
 * hook, because events missed while disconnected are never replayed: the app refetches.
 *
 * The rest of the app depends on the `Realtime` interface only, so tests use a fake.
 */
import { signal, type ReadonlySignal } from '@preact/signals'
import { isApiError, request } from '../api/client.ts'

export type ConnectionState = 'connected' | 'connecting' | 'disconnected'

export type EventHandlers = Record<string, (payload: unknown) => void>

export interface Realtime {
  readonly state: ReadonlySignal<ConnectionState>
  /**
   * Subscribes to a channel (`private-channel.12`) and binds its events. `onError` gets the
   * HTTP status of a refused authorization (403/404 once membership is gone), or null.
   * Returns the unsubscribe function.
   */
  subscribe(name: string, handlers: EventHandlers, onError?: (status: number | null) => void): () => void
  /** Called each time the connection comes back after having been up (not on the first connect). */
  onReconnect(listener: () => void): () => void
  disconnect(): void
}

interface AuthData {
  auth: string
  channel_data?: string
}

/** POST /broadcasting/auth for the socket, through the API client (cookie + XSRF). */
function authorize(socketId: string, channelName: string): Promise<AuthData> {
  return request<AuthData>('/broadcasting/auth', {
    method: 'POST',
    body: { socket_id: socketId, channel_name: channelName },
    // A refusal is a channel matter (handled per subscription), not a sign-out.
    quiet: true,
  })
}

/** Maps pusher-js's six connection states onto the three the UI cares about. */
export function toConnectionState(pusherState: string): ConnectionState {
  if (pusherState === 'connected') return 'connected'
  if (pusherState === 'initialized' || pusherState === 'connecting') return 'connecting'
  return 'disconnected' // unavailable, failed, disconnected
}

export async function connectRealtime(appKey: string): Promise<Realtime> {
  // Loaded on demand: the signed-out screen never needs it.
  const { default: Pusher } = await import('pusher-js')
  const secure = location.protocol === 'https:'
  const port = Number(location.port) || (secure ? 443 : 80)
  const authStatus = new Map<string, number | null>()

  const pusher = new Pusher(appKey, {
    cluster: '', // unused: the host is given
    wsHost: location.hostname,
    wsPort: port,
    wssPort: port,
    forceTLS: secure,
    enabledTransports: ['ws', 'wss'],
    disableStats: true,
    channelAuthorization: {
      customHandler: ({ socketId, channelName }, callback) => {
        authorize(socketId, channelName).then(
          (data) => {
            authStatus.delete(channelName)
            callback(null, data)
          },
          (error: unknown) => {
            authStatus.set(channelName, isApiError(error) ? error.status : null)
            callback(error instanceof Error ? error : new Error(String(error)), null)
          },
        )
      },
    },
  })

  const state = signal<ConnectionState>(toConnectionState(pusher.connection.state))
  const reconnectListeners = new Set<() => void>()
  let wasConnected = false
  pusher.connection.bind('state_change', ({ current }: { current: string }) => {
    const next = toConnectionState(current)
    const reconnected = next === 'connected' && state.value !== 'connected' && wasConnected
    state.value = next
    if (next === 'connected') wasConnected = true
    if (reconnected) for (const listener of [...reconnectListeners]) listener()
  })

  return {
    state,
    subscribe(name, handlers, onError) {
      const channel = pusher.subscribe(name)
      const bound = Object.entries(handlers)
      for (const [event, handler] of bound) channel.bind(event, handler)
      const failed = () => onError?.(authStatus.get(name) ?? null)
      channel.bind('pusher:subscription_error', failed)
      return () => {
        for (const [event, handler] of bound) channel.unbind(event, handler)
        channel.unbind('pusher:subscription_error', failed)
        pusher.unsubscribe(name)
        authStatus.delete(name)
      }
    },
    onReconnect(listener) {
      reconnectListeners.add(listener)
      return () => reconnectListeners.delete(listener)
    },
    disconnect() {
      reconnectListeners.clear()
      pusher.disconnect()
    },
  }
}
