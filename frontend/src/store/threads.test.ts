import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientState } from '../api/client.ts'
import { api } from '../api/endpoints.ts'
import type { Message } from '../api/types.ts'
import { ME, channel, live, tombstone } from '../test/fixtures.ts'
import { FakeRealtime, deferred, fakeFetch, flush, type FakeHandler, type FakeReply } from '../test/fakes.ts'
import { createChat } from './chat.ts'
import { resetChannels } from './channels.ts'
import type { Entry } from './merge.ts'
import { channelKey, resetTimelines, threadKey, timeline } from './messages.ts'
import { session } from './session.ts'

const CHANNEL = 7
const PARENT = 10
const ME_USER = { id: ME.id, name: ME.name, avatar_url: null }

let realtime: FakeRealtime

function setup(routes: Record<string, FakeHandler>) {
  const server = fakeFetch({ 'GET /api/v1/channels': () => ({ body: [channel(CHANNEL)] }), ...routes })
  vi.stubGlobal('fetch', server.fetch)
  let drawn = 0
  const chat = createChat({ api, realtime, uuid: () => `00000000-0000-4000-8000-00000000000${drawn++}`, now: () => new Date('2026-10-30T10:00:00Z') })
  return { chat, server }
}

const at = (minute: number) => `2026-10-30T09:${String(minute).padStart(2, '0')}:00.000Z`
const reply = (id: number, extra: Partial<Message> = {}) => live(id, { parent_id: PARENT, created_at: at(id % 60), ...extra } as never)
const parentEntry = () => {
  const entry = timeline(channelKey(CHANNEL)).value.entries.find((e) => e.kind === 'server' && e.message.id === PARENT)
  return entry?.kind === 'server' ? entry.message : null
}
const summary = (list: Entry[]) =>
  list.map((e) => (e.kind === 'pending' ? `pending:${e.status}` : e.message.deleted ? `${e.message.id}:deleted` : `${e.message.id}:${e.message.body}`))

beforeEach(() => {
  realtime = new FakeRealtime()
  session.value = { status: 'signed-in', me: ME }
  resetClientState()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetTimelines()
  resetChannels()
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
})

describe('threads', () => {
  it('loads a thread: its parent and replies ascending, replies kept out of the channel timeline', async () => {
    const { chat, server } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(PARENT, { reply_count: 2, last_reply_at: at(12) })], has_more: false } }),
      'GET /api/v1/messages/10/replies': () => ({ body: { parent: live(PARENT, { reply_count: 2, last_reply_at: at(12) }), data: [reply(11), reply(12)], has_more: false } }),
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    chat.openThread(CHANNEL, PARENT)
    await flush()

    const thread = timeline(threadKey(PARENT)).value
    expect(thread.status).toBe('ready')
    expect(thread.parent?.id).toBe(PARENT)
    expect(summary(thread.entries)).toEqual(['11:message 11', '12:message 12'])
    expect(summary(timeline(channelKey(CHANNEL)).value.entries)).toEqual(['10:message 10'])
    expect(server.calls.find((c) => c.path === '/api/v1/messages/10/replies')?.query.get('limit')).toBe('50')
  })

  it('thread_reply_updates_parent_summary_locally', async () => {
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(PARENT, { reply_count: 1, last_reply_at: at(11) })], has_more: false } }),
      // The thread is not open: the summary is kept up to date from the events alone.
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()

    realtime.emit('private-channel.7', 'message.created', reply(12))
    expect(parentEntry()).toMatchObject({ reply_count: 2, last_reply_at: at(12) })
    // The same event twice counts once.
    realtime.emit('private-channel.7', 'message.created', reply(12))
    expect(parentEntry()).toMatchObject({ reply_count: 2, last_reply_at: at(12) })
    // An edit or a reaction of a reply changes nothing.
    realtime.emit('private-channel.7', 'message.updated', reply(12, { body: 'fixed', edited_at: at(30) }))
    expect(parentEntry()).toMatchObject({ reply_count: 2 })
    // A deleted reply no longer counts (once), and the last one gone leaves no "last reply".
    realtime.emit('private-channel.7', 'message.deleted', tombstone(12, { parent_id: PARENT }))
    realtime.emit('private-channel.7', 'message.deleted', tombstone(12, { parent_id: PARENT }))
    expect(parentEntry()).toMatchObject({ reply_count: 1 })
    realtime.emit('private-channel.7', 'message.deleted', tombstone(11, { parent_id: PARENT }))
    expect(parentEntry()).toMatchObject({ reply_count: 0, last_reply_at: null })

    // My own reply: the POST response and the event count once together.
    const response = deferred<FakeReply>()
    const second = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(PARENT)], has_more: false } }),
      'GET /api/v1/messages/10/replies': () => ({ body: { parent: live(PARENT), data: [], has_more: false } }),
      'POST /api/v1/channels/7/messages': () => response.promise,
    })
    resetTimelines()
    await second.chat.start()
    second.chat.openChannel(CHANNEL)
    second.chat.openThread(CHANNEL, PARENT)
    await flush()
    second.chat.send(CHANNEL, 'on it', { parentId: PARENT })
    expect(summary(timeline(threadKey(PARENT)).value.entries)).toEqual(['pending:sending'])
    const mine = reply(20, { body: 'on it', user: ME_USER, client_id: '00000000-0000-4000-8000-000000000000' })
    realtime.emit('private-channel.7', 'message.created', mine)
    response.resolve({ status: 201, body: mine })
    await flush()
    expect(summary(timeline(threadKey(PARENT)).value.entries)).toEqual(['20:on it'])
    expect(parentEntry()).toMatchObject({ reply_count: 1, last_reply_at: at(20) })
    expect(timeline(threadKey(PARENT)).value.parent).toMatchObject({ reply_count: 1, last_reply_at: at(20) })
    // The POST carried the parent.
  })

  it('deleted_parent_shows_tombstone_and_replies (store): a deleted parent keeps its thread', async () => {
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(PARENT, { reply_count: 1, last_reply_at: at(11) })], has_more: false } }),
      'GET /api/v1/messages/10/replies': () => ({ body: { parent: live(PARENT, { reply_count: 1, last_reply_at: at(11) }), data: [reply(11)], has_more: false } }),
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    chat.openThread(CHANNEL, PARENT)
    await flush()

    realtime.emit('private-channel.7', 'message.deleted', tombstone(PARENT, { reply_count: 1, last_reply_at: at(11) }))
    expect(timeline(threadKey(PARENT)).value.parent).toMatchObject({ id: PARENT, deleted: true, reply_count: 1 })
    expect(parentEntry()).toMatchObject({ deleted: true, reply_count: 1 })
    expect(summary(timeline(threadKey(PARENT)).value.entries)).toEqual(['11:message 11'])
  })

  it('a thread that does not exist (or is in another channel) says so', async () => {
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
      'GET /api/v1/messages/10/replies': () => ({ status: 404, body: { message: 'Not Found' } }),
      'GET /api/v1/messages/11/replies': () => ({ body: { parent: live(11, { channel_id: 8 }), data: [], has_more: false } }),
    })
    await chat.start()
    chat.openThread(CHANNEL, PARENT)
    chat.openThread(CHANNEL, 11)
    await flush()
    expect(timeline(threadKey(PARENT)).value).toMatchObject({ status: 'error', missing: true })
    expect(timeline(threadKey(11)).value).toMatchObject({ status: 'error', missing: true })
  })

  it('refetches the open thread after a reconnection; other threads become stale', async () => {
    let replies: Message[] = [reply(11)]
    const { chat, server } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(PARENT)], has_more: false } }),
      'GET /api/v1/messages/10/replies': () => ({ body: { parent: live(PARENT, { reply_count: replies.length }), data: replies, has_more: false } }),
      'GET /api/v1/messages/30/replies': () => ({ body: { parent: live(30), data: [], has_more: false } }),
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    chat.openThread(CHANNEL, 30)
    await flush()
    chat.closeThread(30)
    chat.openThread(CHANNEL, PARENT)
    await flush()

    realtime.drop()
    replies = [reply(11), reply(12, { body: 'missed' })]
    realtime.reconnect()
    await flush()
    await flush()
    expect(summary(timeline(threadKey(PARENT)).value.entries)).toEqual(['11:message 11', '12:missed'])
    expect(timeline(threadKey(30)).value.stale).toBe(true)
    expect(server.calls.filter((c) => c.path === '/api/v1/messages/10/replies')).toHaveLength(2)
  })

  it('holds reply events while the thread loads, and applies them after the page', async () => {
    const page = deferred<FakeReply>()
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
      'GET /api/v1/messages/10/replies': () => page.promise,
    })
    await chat.start()
    chat.openThread(CHANNEL, PARENT)
    await flush()
    realtime.emit('private-channel.7', 'message.created', reply(13, { body: 'live' }))
    realtime.emit('private-channel.7', 'message.deleted', tombstone(11, { parent_id: PARENT }))
    page.resolve({ body: { parent: live(PARENT), data: [reply(11), reply(12)], has_more: false } })
    await flush()
    expect(summary(timeline(threadKey(PARENT)).value.entries)).toEqual(['11:deleted', '12:message 12', '13:live'])
  })
})
