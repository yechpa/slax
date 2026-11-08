/** Test data shaped like the API's resources. */
import type { Channel, DeletedMessage, LiveMessage, Me, Task, TaskList, UserSummary } from '../api/types.ts'

export const ME: Me = {
  id: 1,
  name: 'Alice',
  email: 'alice@example.test',
  avatar_url: null,
  locale: 'en',
  theme: 'console',
  is_admin: false,
  workspace_id: 1,
}

export const DANA: UserSummary = { id: 2, name: 'dana', avatar_url: null }
export const NOAM: UserSummary = { id: 3, name: 'נעם', avatar_url: null }

export function live(id: number, overrides: Partial<LiveMessage> = {}): LiveMessage {
  return {
    id,
    channel_id: 7,
    parent_id: null,
    created_at: new Date(Date.UTC(2026, 9, 30, 9, 0, id)).toISOString(),
    reply_count: 0,
    last_reply_at: null,
    deleted: false,
    client_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    user: DANA,
    body: `message ${id}`,
    edited_at: null,
    reactions: [],
    files: [],
    ...overrides,
  }
}

export function tombstone(id: number, overrides: Partial<DeletedMessage> = {}): DeletedMessage {
  return {
    id,
    channel_id: 7,
    parent_id: null,
    created_at: new Date(Date.UTC(2026, 9, 30, 9, 0, id)).toISOString(),
    reply_count: 0,
    last_reply_at: null,
    deleted: true,
    ...overrides,
  }
}

export function channel(id: number, overrides: Partial<Channel> = {}): Channel {
  return {
    id,
    kind: 'public',
    name: `room-${id}`,
    topic: null,
    is_member: true,
    member_count: 3,
    last_read_message_id: null,
    unread_count: 0,
    ...overrides,
  }
}

const summary = (u: UserSummary): UserSummary => ({ id: u.id, name: u.name, avatar_url: u.avatar_url })

/** A task of mine (created by and assigned to ME) in list 1 unless overridden. */
export function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `task ${id}`,
    visibility: 'private',
    completed: false,
    completed_at: null,
    list_id: 1,
    position: id,
    creator: summary(ME),
    assignee: summary(ME),
    created_at: '2026-11-08T08:00:00.000Z',
    ...overrides,
  }
}

export function taskList(id: number, overrides: Partial<TaskList> = {}): TaskList {
  return { id, name: `list ${id}`, position: id, open_count: 0, ...overrides }
}
