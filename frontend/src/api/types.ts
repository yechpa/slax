/**
 * Shapes of the Slax API (Laravel resources under backend/app/Http/Resources).
 * Bare objects and arrays: the API does not wrap resources in {"data": …},
 * except paginated message lists ({data, has_more}).
 */
import type { Locale } from '../i18n/index.ts'
import type { Theme } from '../theme.ts'

/** GET /api/v1/me (UserResource). */
export interface Me {
  id: number
  name: string
  email: string
  avatar_url: string | null
  locale: Locale
  theme: Theme
  is_admin: boolean
  /** The single workspace (its presence channel is `presence-workspace.{id}`). */
  workspace_id: number | null
}

/** A person as embedded in messages and conversations: no e-mail address. */
export interface UserSummary {
  id: number
  name: string
  avatar_url: string | null
}

export type ChannelKind = 'public' | 'private' | 'dm' | 'group_dm'

/** GET /api/v1/channels, /channels/{id} (ChannelResource). */
export interface Channel {
  id: number
  kind: ChannelKind
  /** Null for direct conversations, which are titled after their members. */
  name: string | null
  topic: string | null
  is_member: boolean
  member_count: number
  /** The caller's read pointer (top-level message id), null when never read or not a member. */
  last_read_message_id: number | null
  /** True count of new messages by others; the UI caps what it shows. */
  unread_count: number
  /** Only for dm and group_dm. */
  members?: UserSummary[]
}

/** {emoji, count, reacted_by_me, user_ids (first 50 reactors)}: broadcasts always say reacted_by_me=false. */
export interface Reaction {
  emoji: string
  count: number
  reacted_by_me: boolean
  user_ids: number[]
}

export interface FileInfo {
  id: number
  name: string
  mime: string
  size: number
  /** image, pdf or other. */
  kind: string
  /** Same-origin; redirects to a short-lived URL of the object. */
  download_url: string
}

/** GET /channels/{id}/members: public profile and role, owners first. */
export interface ChannelMember extends UserSummary {
  role: 'owner' | 'member'
}

export type PresenceState = 'online' | 'away' | 'offline'

interface MessageBase {
  id: number
  channel_id: number
  parent_id: number | null
  created_at: string
  reply_count: number
  last_reply_at: string | null
}

export interface LiveMessage extends MessageBase {
  deleted: false
  client_id: string
  user: UserSummary
  body: string
  edited_at: string | null
  reactions: Reaction[]
  files: FileInfo[]
}

/** What remains of a deleted message: no author, body, reactions or files. */
export interface DeletedMessage extends MessageBase {
  deleted: true
}

/** MessageResource: a live message or a tombstone. */
export type Message = LiveMessage | DeletedMessage

/** GET /channels/{id}/messages and /messages/{id}/replies: one page, ascending ids. */
export interface MessagePage {
  data: Message[]
  has_more: boolean
}

export interface RepliesPage extends MessagePage {
  parent: Message
}

/** Typing whisper on `private-channel.{id}` (client event `client-typing`); `user_id` is tagged by Reverb. */
export interface TypingWhisper {
  typing: boolean
  /** The thread being replied to, or null for the channel itself. */
  parent_id: number | null
}

/** Realtime events on `private-channel.{id}`; every payload is a MessageResource. */
export type MessageEventName = 'message.created' | 'message.updated' | 'message.deleted' | 'reaction.changed'
