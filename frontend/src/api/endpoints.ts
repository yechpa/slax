/** Typed calls to the Slax API. Permissions are the server's business: callers show its errors. */
import type { Locale } from '../i18n/index.ts'
import type { Theme } from '../theme.ts'
import { apiPath, request } from './client.ts'
import type { Channel, Me, Message, MessagePage } from './types.ts'

export const api = {
  /** 401 (ApiError 'unauthenticated') when signed out; quiet: start-up decides what that means. */
  me: (signal?: AbortSignal) => request<Me>(apiPath('/me'), { signal, quiet: true }),
  updateMe: (changes: { locale?: Locale; theme?: Theme }) => request<Me>(apiPath('/me'), { method: 'PATCH', body: changes }),
  logout: () => request<void>(apiPath('/auth/logout'), { method: 'POST' }),
  /** Starts Google sign-in after Turnstile; the browser then goes to `redirect_url`. */
  startGoogle: (turnstileToken: string) =>
    request<{ redirect_url: string }>(apiPath('/auth/google/start'), {
      method: 'POST',
      body: { turnstile_token: turnstileToken },
      quiet: true,
    }),

  channels: (signal?: AbortSignal) => request<Channel[]>(apiPath('/channels'), { signal }),
  channel: (id: number, signal?: AbortSignal) => request<Channel>(apiPath(`/channels/${id}`), { signal }),
  joinChannel: (id: number) => request<Channel>(apiPath(`/channels/${id}/join`), { method: 'POST' }),
  markRead: (channelId: number, messageId: number) =>
    request<void>(apiPath(`/channels/${channelId}/read`), { method: 'POST', body: { message_id: messageId } }),

  /** One page, ascending ids. No cursor: the latest; `before`: older; `after`: newer. */
  messages: (channelId: number, cursor: { before?: number; after?: number; limit?: number } = {}, signal?: AbortSignal) =>
    request<MessagePage>(apiPath(`/channels/${channelId}/messages`), { query: cursor, signal }),
  /** 201 for a new message, 200 for a replay of the same client_id: the same message either way. */
  postMessage: (channelId: number, message: { body: string; client_id: string; parent_id?: number | null }) =>
    request<Message>(apiPath(`/channels/${channelId}/messages`), { method: 'POST', body: message }),
}

export type Api = typeof api
