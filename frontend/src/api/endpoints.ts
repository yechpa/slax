/** Typed calls to the Slax API. Permissions are the server's business: callers show its errors. */
import type { Locale } from '../i18n/index.ts'
import type { Theme } from '../theme.ts'
import { apiPath, request, requestWithStatus } from './client.ts'
import type {
  AdminAccount,
  AdminChannel,
  AdminStatus,
  AuditPage,
  Channel,
  ChannelMember,
  Me,
  Message,
  MessagePage,
  ModeratedUser,
  PresenceState,
  RepliesPage,
  UserSummary,
} from './types.ts'

const emojiPath = (messageId: number, emoji: string) => apiPath(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`)

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
  leaveChannel: (id: number) => request<void>(apiPath(`/channels/${id}/leave`), { method: 'POST' }),
  createChannel: (channel: { name: string; kind: 'public' | 'private'; topic: string | null }) =>
    request<Channel>(apiPath('/channels'), { method: 'POST', body: channel }),
  channelMembers: (id: number, signal?: AbortSignal) => request<ChannelMember[]>(apiPath(`/channels/${id}/members`), { signal }),
  addMember: (id: number, userId: number) => request<unknown>(apiPath(`/channels/${id}/members`), { method: 'POST', body: { user_id: userId } }),
  removeMember: (id: number, userId: number) => request<void>(apiPath(`/channels/${id}/members/${userId}`), { method: 'DELETE' }),
  /** 201 for a new conversation, 200 for the existing one with exactly these people. */
  openConversation: (userIds: number[]) => requestWithStatus<Channel>(apiPath('/dms'), { method: 'POST', body: { user_ids: userIds } }),
  /** `notInChannel`: its members are left out (by the server, however many they are). */
  searchUsers: (q: string, signal?: AbortSignal, notInChannel?: number) =>
    request<UserSummary[]>(apiPath('/users'), { query: { q, not_in_channel: notInChannel }, signal }),
  markRead: (channelId: number, messageId: number) =>
    request<void>(apiPath(`/channels/${channelId}/read`), { method: 'POST', body: { message_id: messageId } }),

  /** One page, ascending ids. No cursor: the latest; `before`: older; `after`: newer. */
  messages: (channelId: number, cursor: { before?: number; after?: number; limit?: number } = {}, signal?: AbortSignal) =>
    request<MessagePage>(apiPath(`/channels/${channelId}/messages`), { query: cursor, signal }),
  /** 201 for a new message, 200 for a replay of the same client_id: the same message either way. */
  postMessage: (channelId: number, message: { body: string; client_id: string; parent_id?: number | null; file_ids?: number[] }) =>
    request<Message>(apiPath(`/channels/${channelId}/messages`), { method: 'POST', body: message }),
  /** A thread: its parent (or tombstone) and one page of replies, ascending ids. */
  replies: (parentId: number, cursor: { before?: number; after?: number; limit?: number } = {}, signal?: AbortSignal) =>
    request<RepliesPage>(apiPath(`/messages/${parentId}/replies`), { query: cursor, signal }),
  editMessage: (id: number, body: string) => request<Message>(apiPath(`/messages/${id}`), { method: 'PATCH', body: { body } }),
  deleteMessage: (id: number) => request<Message>(apiPath(`/messages/${id}`), { method: 'DELETE' }),
  react: (id: number, emoji: string) => request<Message>(emojiPath(id, emoji), { method: 'PUT' }),
  unreact: (id: number, emoji: string) => request<Message>(emojiPath(id, emoji), { method: 'DELETE' }),

  /** Quiet: presence is background work, its 429 is not worth a toast. */
  heartbeat: (active: boolean) => request<void>(apiPath('/presence/heartbeat'), { method: 'POST', body: { active }, quiet: true }),
  presence: (userIds: number[], signal?: AbortSignal) =>
    request<Record<string, PresenceState>>(apiPath('/presence'), { query: { 'user_ids[]': userIds }, signal, quiet: true }),

  /** Web Push on this device (pwa/push.ts). 404 `push_disabled` when the server has no VAPID keys. */
  push: {
    publicKey: () => request<{ public_key: string }>(apiPath('/push/public-key'), { quiet: true }),
    /** Upsert by endpoint: also refreshes the keys and the language of an existing device. */
    subscribe: (subscription: { endpoint: string; keys: { p256dh: string; auth: string }; locale: Locale }) =>
      request<void>(apiPath('/push/subscriptions'), { method: 'POST', body: subscription, quiet: true }),
    unsubscribe: (endpoint: string) => request<void>(apiPath('/push/subscriptions'), { method: 'DELETE', body: { endpoint }, quiet: true }),
    /** 202 {devices}: a test notification to each of this account's devices. */
    test: () => request<{ devices: number }>(apiPath('/push/test'), { method: 'POST' }),
  },

  /** Administrators only (403 for everyone else): moderation, audit log, service status. */
  admin: {
    status: (signal?: AbortSignal) => request<AdminStatus>(apiPath('/admin/status'), { signal }),
    audit: (page: number, signal?: AbortSignal) => request<AuditPage>(apiPath('/admin/audit'), { query: { page }, signal }),
    accounts: (signal?: AbortSignal) => request<{ data: AdminAccount[] }>(apiPath('/admin/users'), { signal }),
    setAccountType: (userId: number, accountType: AdminAccount['account_type']) =>
      request<AdminAccount>(apiPath(`/admin/users/${userId}/account-type`), { method: 'POST', body: { account_type: accountType } }),
    banned: (signal?: AbortSignal) => request<{ data: ModeratedUser[] }>(apiPath('/admin/users/banned'), { signal }),
    /** Idempotent; `false` lifts the ban. */
    ban: (userId: number, banned: boolean) => request<ModeratedUser>(apiPath(`/admin/users/${userId}/ban`), { method: 'POST', body: { banned } }),
    /** The tombstone; 503 `storage_unavailable` when a file could not be removed yet (retry). */
    deleteMessage: (id: number) => request<Message>(apiPath(`/admin/messages/${id}`), { method: 'DELETE' }),
    deleteFile: (id: number) => request<void>(apiPath(`/admin/files/${id}`), { method: 'DELETE' }),
    channels: (signal?: AbortSignal) => request<{ data: AdminChannel[] }>(apiPath('/admin/channels'), { signal }),
    /** Idempotent; `false` unlocks. */
    lock: (channelId: number, locked: boolean) =>
      request<{ id: number; name: string; locked: boolean }>(apiPath(`/admin/channels/${channelId}/lock`), { method: 'POST', body: { locked } }),
  },
}

export type Api = typeof api
