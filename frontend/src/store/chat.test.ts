import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientState } from '../api/client.ts'
import { api } from '../api/endpoints.ts'
import type { Message } from '../api/types.ts'
import { ME, channel, live, tombstone } from '../test/fixtures.ts'
import { FakeRealtime, deferred, fakeFetch, flush, type FakeReply } from '../test/fakes.ts'
import { FAILURES_BEFORE_NOTICE, createChat } from './chat.ts'
import { channelById, channels, resetChannels } from './channels.ts'
import type { Entry } from './merge.ts'
import { channelKey, resetTimelines, timeline } from './messages.ts'
import { session } from './session.ts'

const CHANNEL = 7
const UUID = '6f1c2a5e-0b9d-4c47-9a3e-1d2b3c4d5e6f'
const entries = () => timeline(channelKey(CHANNEL)).value.entries
const summary = (list: Entry[]) =>
  list.map((e) => (e.kind === 'pending' ? `pending:${e.status}` : e.message.deleted ? `${e.message.id}:deleted` : `${e.message.id}:${e.message.body}`))

let realtime: FakeRealtime

function setup(routes: Parameters<typeof fakeFetch>[0]) {
  const server = fakeFetch({
    'GET /api/v1/channels': () => ({ body: [channel(CHANNEL), channel(8, { name: 'other' })] }),
    ...routes,
  })
  vi.stubGlobal('fetch', server.fetch)
  // The first id is UUID; any later one differs (a retry must not draw a new one).
  let drawn = 0
  const uuid = () => (drawn++ === 0 ? UUID : `0000000${drawn}-0000-4000-8000-000000000000`)
  const chat = createChat({ api, realtime, uuid, now: () => new Date('2026-10-30T10:00:00Z') })
  return { chat, server }
}

/** The server's copy of the message the user is sending. */
const mine = (id: number, body = 'hello'): Message => live(id, { client_id: UUID, body, user: { id: ME.id, name: ME.name, avatar_url: null } })

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

describe('REST answers older than live events', () => {
  const tada = [{ emoji: '🎉', count: 1, reacted_by_me: false, user_ids: [2] }]
  const first = (): Message => {
    const entry = entries()[0]
    if (entry?.kind !== 'server') throw new Error('no message')
    return entry.message
  }

  it('an edit answer keeps a newer event and still shows the edit', async () => {
    const answers: ReturnType<typeof deferred<FakeReply>>[] = []
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(1)], has_more: false } }),
      'PATCH /api/v1/messages/1': () => {
        const answer = deferred<FakeReply>()
        answers.push(answer)
        return answer.promise
      },
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()

    // Dana reacts just after my edit: her broadcast (edit included) comes before my answer.
    const editing = chat.editMessage(1, 'fixed')
    await flush()
    const edited = { body: 'fixed', edited_at: '2026-10-30T10:01:00.000Z' }
    realtime.emit('private-channel.7', 'reaction.changed', live(1, { ...edited, reactions: tada }))
    answers[0].resolve({ body: live(1, edited) })
    await editing
    expect(first()).toMatchObject({ ...edited, reactions: tada })

    // Dana reacts just before my next edit: her broadcast is older than my answer.
    const again = chat.editMessage(1, 'fixed again')
    await flush()
    realtime.emit('private-channel.7', 'reaction.changed', live(1, { ...edited, reactions: [...tada, { emoji: '👀', count: 1, reacted_by_me: false, user_ids: [2] }] }))
    const newer = { body: 'fixed again', edited_at: '2026-10-30T10:02:00.000Z' }
    answers[1].resolve({ body: live(1, { ...newer, reactions: [...tada, { emoji: '👀', count: 1, reacted_by_me: false, user_ids: [2] }] }) })
    await again
    const latest = first()
    expect(latest).toMatchObject(newer)
    expect(latest.deleted ? [] : latest.reactions.map((r) => r.emoji)).toEqual(['🎉', '👀'])
  })

  it('a page asked for before a reply event does not take back the thread summary', async () => {
    const latest = deferred<FakeReply>()
    let reconnected = false
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': ({ query }) => {
        if (!reconnected) return { body: { data: [live(1)], has_more: false } }
        if (query.get('after') === '1') return { body: { data: [], has_more: false } }
        return latest.promise
      },
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()

    realtime.drop()
    reconnected = true
    realtime.reconnect()
    await flush()
    // A reply comes while the catch-up's latest page is on its way.
    realtime.emit('private-channel.7', 'message.created', live(2, { parent_id: 1, created_at: '2026-10-30T10:00:30.000Z' }))
    expect(first()).toMatchObject({ reply_count: 1, last_reply_at: '2026-10-30T10:00:30.000Z' })
    latest.resolve({ body: { data: [live(1)], has_more: false } })
    await flush()
    expect(first()).toMatchObject({ reply_count: 1, last_reply_at: '2026-10-30T10:00:30.000Z' })
  })

  /** A catch-up whose latest page answers `latest` while a live event (or two) arrives. */
  async function catchUpWith(during: () => void, latest: Message) {
    const answer = deferred<FakeReply>()
    let reconnected = false
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': ({ query }) => {
        if (!reconnected) return { body: { data: [live(1, { reply_count: 1, last_reply_at: '2026-10-30T09:00:00.000Z' })], has_more: false } }
        if (query.get('after') === '1') return { body: { data: [], has_more: false } }
        return answer.promise
      },
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()
    realtime.drop()
    reconnected = true
    realtime.reconnect()
    await flush()
    during()
    answer.resolve({ body: { data: [latest], has_more: false } })
    await flush()
  }
  const replyAt = (id: number, at: string) => live(id, { parent_id: 1, created_at: at })

  it('a reply during a catch-up adds to the repaired summary, never replaces it', async () => {
    // Two replies were missed while away (1 -> 3, the latest at 10:00:20); one more comes during the catch-up.
    await catchUpWith(
      () => {
        realtime.emit('private-channel.7', 'message.created', replyAt(5, '2026-10-30T10:00:30.000Z'))
        expect(first()).toMatchObject({ reply_count: 2 })
      },
      live(1, { reply_count: 3, last_reply_at: '2026-10-30T10:00:20.000Z' }),
    )
    expect(first()).toMatchObject({ reply_count: 4, last_reply_at: '2026-10-30T10:00:30.000Z' })
  })

  it('a reply the catch-up page already counts is not counted twice', async () => {
    await catchUpWith(
      () => realtime.emit('private-channel.7', 'message.created', replyAt(5, '2026-10-30T10:00:30.000Z')),
      live(1, { reply_count: 4, last_reply_at: '2026-10-30T10:00:30.000Z' }),
    )
    expect(first()).toMatchObject({ reply_count: 4, last_reply_at: '2026-10-30T10:00:30.000Z' })
  })

  it('an edit snapshot during the catch-up wins over the older page, summary included', async () => {
    const edited = { body: 'edited', edited_at: '2026-10-30T10:00:40.000Z', reply_count: 3, last_reply_at: '2026-10-30T10:00:20.000Z' }
    await catchUpWith(
      () => {
        realtime.emit('private-channel.7', 'message.updated', live(1, edited))
        realtime.emit('private-channel.7', 'message.created', replyAt(5, '2026-10-30T10:00:50.000Z'))
      },
      live(1, { reply_count: 3, last_reply_at: '2026-10-30T10:00:20.000Z' }),
    )
    expect(first()).toMatchObject({ body: 'edited', reply_count: 4, last_reply_at: '2026-10-30T10:00:50.000Z' })
  })

  it('a deletion in a page is final, even after a live event', async () => {
    const latest = deferred<FakeReply>()
    let reconnected = false
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': ({ query }) => {
        if (!reconnected) return { body: { data: [live(1)], has_more: false } }
        if (query.get('after') === '1') return { body: { data: [], has_more: false } }
        return latest.promise
      },
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()

    realtime.drop()
    reconnected = true
    realtime.reconnect()
    await flush()
    realtime.emit('private-channel.7', 'reaction.changed', live(1, { reactions: tada }))
    latest.resolve({ body: { data: [tombstone(1)], has_more: false } })
    await flush()
    expect(first().deleted).toBe(true)
  })

  it('my POST answer does not undo a reaction that came before it', async () => {
    const response = deferred<FakeReply>()
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
      'POST /api/v1/channels/7/messages': () => response.promise,
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()

    chat.send(CHANNEL, 'hello')
    realtime.emit('private-channel.7', 'message.created', mine(2))
    realtime.emit('private-channel.7', 'reaction.changed', { ...mine(2), reactions: tada })
    response.resolve({ status: 201, body: mine(2) })
    await flush()
    expect(first()).toMatchObject({ id: 2, reactions: tada })
  })
})

describe('optimistic sending', () => {
  it('optimistic_message_replaced_by_server_copy_without_duplicate', async () => {
    // Order 1: the POST response first, then the realtime event.
    const response = deferred<FakeReply>()
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(1)], has_more: false } }),
      'POST /api/v1/channels/7/messages': () => response.promise,
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()

    chat.send(CHANNEL, 'hello')
    expect(summary(entries())).toEqual(['1:message 1', 'pending:sending'])

    response.resolve({ status: 201, body: mine(2) })
    await flush()
    expect(summary(entries())).toEqual(['1:message 1', '2:hello'])
    realtime.emit('private-channel.7', 'message.created', mine(2))
    expect(summary(entries())).toEqual(['1:message 1', '2:hello'])

    // Order 2: the realtime event first, then the POST response.
    resetTimelines()
    const second = deferred<FakeReply>()
    const other = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(1)], has_more: false } }),
      'POST /api/v1/channels/7/messages': () => second.promise,
    })
    await other.chat.start()
    other.chat.openChannel(CHANNEL)
    await flush()

    other.chat.send(CHANNEL, 'hello')
    realtime.emit('private-channel.7', 'message.created', mine(3))
    expect(summary(entries())).toEqual(['1:message 1', '3:hello'])
    second.resolve({ status: 201, body: mine(3) })
    await flush()
    expect(summary(entries())).toEqual(['1:message 1', '3:hello'])
    // Never counted as unread: it is mine.
    expect(channelById.value.get(CHANNEL)?.unread_count).toBe(0)
  })

  it('send_failure_retry_reuses_client_id', async () => {
    let attempts = 0
    const { chat, server } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
      'POST /api/v1/channels/7/messages': () => {
        attempts += 1
        return attempts === 1 ? 'network-error' : { status: 201, body: mine(5) }
      },
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()

    const clientId = chat.send(CHANNEL, 'hello')
    await flush()
    const failed = entries()[0]
    expect(failed.kind === 'pending' && failed.status).toBe('failed')
    expect(failed.kind === 'pending' && failed.error).toBe('network')

    chat.retry(CHANNEL, clientId)
    expect(summary(entries())).toEqual(['pending:sending'])
    await flush()
    expect(summary(entries())).toEqual(['5:hello'])

    const posts = server.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages'))
    expect(posts).toHaveLength(2)
    expect(posts.map((p) => (p.body as { client_id: string }).client_id)).toEqual([UUID, UUID])
    expect(posts[1].headers['X-XSRF-TOKEN']).toBe('test+token')
  })

  it('a failed message the server did store is confirmed by the realtime copy', async () => {
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
      'POST /api/v1/channels/7/messages': () => ({ status: 500, body: { message: 'Server Error' } }),
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()
    chat.send(CHANNEL, 'hello')
    await flush()
    expect(summary(entries())).toEqual(['pending:failed'])
    realtime.emit('private-channel.7', 'message.created', mine(9))
    expect(summary(entries())).toEqual(['9:hello'])
  })
})

describe('reconnection', () => {
  it('reconnect_fetches_after_last_id_and_merges_in_order', async () => {
    let reconnected = false
    const { chat, server } = setup({
      'GET /api/v1/channels/7/messages': ({ query }) => {
        if (!reconnected) return { body: { data: [live(1), live(2), live(3), live(4), live(5)], has_more: false } }
        if (query.get('after') === '5') return { body: { data: [live(6), live(7)], has_more: false } }
        // The latest page now shows what changed while we were away: 3 edited, 4 deleted.
        return {
          body: {
            data: [live(3, { body: 'edited', edited_at: '2026-10-30T10:01:00Z' }), tombstone(4), live(5), live(6), live(7)],
            has_more: true,
          },
        }
      },
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()
    expect(summary(entries())).toEqual(['1:message 1', '2:message 2', '3:message 3', '4:message 4', '5:message 5'])

    realtime.drop()
    reconnected = true
    realtime.reconnect()
    await flush()

    const messageCalls = server.calls.filter((c) => c.path === '/api/v1/channels/7/messages')
    expect(messageCalls.some((c) => c.query.get('after') === '5')).toBe(true)
    expect(summary(entries())).toEqual([
      '1:message 1',
      '2:message 2',
      '3:edited',
      '4:deleted',
      '5:message 5',
      '6:message 6',
      '7:message 7',
    ])
    // The channel list (unread counts) was refetched too.
    expect(server.calls.filter((c) => c.path === '/api/v1/channels')).toHaveLength(2)
  })

  it('starts again from the latest page when too much was missed', async () => {
    let reconnected = false
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': ({ query }) => {
        if (!reconnected) return { body: { data: [live(1), live(2)], has_more: false } }
        const after = query.get('after')
        if (after !== null) {
          const from = Number(after) + 1
          return { body: { data: Array.from({ length: 100 }, (_, i) => live(from + i)), has_more: true } }
        }
        return { body: { data: [live(900), live(901)], has_more: true } }
      },
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()
    reconnected = true
    realtime.reconnect()
    await flush()
    expect(summary(entries())).toEqual(['900:message 900', '901:message 901'])
    expect(timeline(channelKey(CHANNEL)).value.hasMoreBefore).toBe(true)
  })
})

describe('realtime events', () => {
  it('counts messages of others in other channels as unread, once, and ignores unknown channels', async () => {
    const { chat } = setup({ 'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }) })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()

    const inOther = live(30, { channel_id: 8 })
    realtime.emit('private-channel.8', 'message.created', inOther)
    realtime.emit('private-channel.8', 'message.created', inOther)
    realtime.emit('private-channel.8', 'message.created', live(31, { channel_id: 8, parent_id: 30 }))
    realtime.emit('private-channel.8', 'message.created', live(32, { channel_id: 8, user: { id: ME.id, name: 'me', avatar_url: null } }))
    chat.onMessageEvent(99, 'message.created', live(33, { channel_id: 99 }))
    expect(channelById.value.get(8)?.unread_count).toBe(1)

    // In the open channel: shown, not counted.
    realtime.emit('private-channel.7', 'message.created', live(34))
    expect(summary(entries())).toEqual(['34:message 34'])
    expect(channelById.value.get(CHANNEL)?.unread_count).toBe(0)

    realtime.emit('private-channel.7', 'message.updated', live(34, { body: 'fixed', edited_at: '2026-10-30T10:02:00Z' }))
    realtime.emit('private-channel.7', 'message.deleted', live(35))
    realtime.emit('private-channel.7', 'message.deleted', tombstone(34))
    expect(summary(entries())).toEqual(['34:deleted', '35:message 35'])
  })

  it('subscribes to member channels only and follows the list', async () => {
    let list = [channel(CHANNEL), channel(8, { is_member: false })]
    const { chat } = setup({ 'GET /api/v1/channels': () => ({ body: list }) })
    await chat.start()
    expect([...realtime.subscriptions.keys()]).toEqual(['private-channel.7'])
    list = [channel(8)]
    await chat.refreshChannels()
    expect([...realtime.subscriptions.keys()]).toEqual(['private-channel.8'])
  })

  it('drops a refused subscription, retries it once if still a member, then leaves it', async () => {
    const server = fakeFetch({ 'GET /api/v1/channels': () => ({ body: [channel(CHANNEL)] }) })
    vi.stubGlobal('fetch', server.fetch)
    const chat = createChat({ api, realtime })
    await chat.start()
    realtime.subscriptions.get('private-channel.7')!.onError!(403)
    await flush()
    expect(realtime.subscriptions.has('private-channel.7')).toBe(true)
    realtime.subscriptions.get('private-channel.7')!.onError!(403)
    await flush()
    expect(realtime.subscriptions.has('private-channel.7')).toBe(false)
    expect(server.calls.filter((c) => c.path === '/api/v1/channels')).toHaveLength(3)
  })
})

describe('reading', () => {
  it('counts what arrived unseen in the open channel once it is left', async () => {
    const { chat } = setup({
      'GET /api/v1/channels': () => ({ body: [channel(CHANNEL, { last_read_message_id: 1 })] }),
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(1)], has_more: false } }),
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()
    // The reader is scrolled up: nothing marks these read.
    realtime.emit('private-channel.7', 'message.created', live(2))
    realtime.emit('private-channel.7', 'message.created', live(3))
    realtime.emit('private-channel.7', 'message.created', live(4, { user: { id: ME.id, name: ME.name, avatar_url: null } }))
    expect(channelById.value.get(CHANNEL)?.unread_count).toBe(0)
    chat.closeChannel(CHANNEL)
    expect(channelById.value.get(CHANNEL)?.unread_count).toBe(2)

    // Left right after reading at the bottom: read at once, no badge in between.
    chat.openChannel(CHANNEL)
    chat.noteReadable(CHANNEL)
    chat.closeChannel(CHANNEL)
    expect(channelById.value.get(CHANNEL)).toMatchObject({ unread_count: 0, last_read_message_id: 4 })
  })

  it('marks the newest message read after a quiet second', async () => {
    vi.useFakeTimers()
    const { chat, server } = setup({
      'GET /api/v1/channels': () => ({ body: [channel(CHANNEL, { unread_count: 2, last_read_message_id: 1 })] }),
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(1), live(2), live(3)], has_more: false } }),
      'POST /api/v1/channels/7/read': () => ({ status: 204 }),
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await vi.advanceTimersByTimeAsync(0)
    chat.noteReadable(CHANNEL)
    chat.noteReadable(CHANNEL)
    await vi.advanceTimersByTimeAsync(999)
    expect(server.calls.some((c) => c.path.endsWith('/read'))).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const reads = server.calls.filter((c) => c.path.endsWith('/read'))
    expect(reads.map((c) => c.body)).toEqual([{ message_id: 3 }])
    expect(channelById.value.get(CHANNEL)).toMatchObject({ unread_count: 0, last_read_message_id: 3 })
  })

  it('re-checks visibility, focus and position when the second is up', async () => {
    vi.useFakeTimers()
    const { chat, server } = setup({
      'GET /api/v1/channels': () => ({ body: [channel(CHANNEL, { unread_count: 2, last_read_message_id: 1 })] }),
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(1), live(2), live(3)], has_more: false } }),
      'POST /api/v1/channels/7/read': () => ({ status: 204 }),
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await vi.advanceTimersByTimeAsync(0)
    let readable = true
    chat.noteReadable(CHANNEL, () => readable)
    // The tab was hidden (or the window left, or the list scrolled up) within the second.
    readable = false
    await vi.advanceTimersByTimeAsync(1000)
    chat.noteReadable(CHANNEL, () => readable)
    chat.closeChannel(CHANNEL)
    await vi.advanceTimersByTimeAsync(1000)
    expect(server.calls.some((c) => c.path.endsWith('/read'))).toBe(false)
    expect(channelById.value.get(CHANNEL)).toMatchObject({ unread_count: 2, last_read_message_id: 1 })
  })
})

describe('refreshing without losing events', () => {
  it('keeps showing live events after a failed catch-up, then retries with backoff and repairs', async () => {
    vi.useFakeTimers()
    let reconnected = false
    let failures = 2
    const { chat, server } = setup({
      'GET /api/v1/channels/7/messages': ({ query }) => {
        if (!reconnected) return { body: { data: [live(1), live(2)], has_more: false } }
        if (failures > 0) {
          if (query.get('after') === null) failures -= 1
          return { status: 500, body: { message: 'Server Error' } }
        }
        if (query.get('after') !== null) return { body: { data: [live(3)], has_more: false } }
        return { body: { data: [live(1, { body: 'edited', edited_at: '2026-10-30T10:01:00Z' }), live(2), live(3)], has_more: false } }
      },
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await vi.advanceTimersByTimeAsync(0)
    reconnected = true
    realtime.reconnect()
    await vi.advanceTimersByTimeAsync(0)

    // The catch-up failed: the open channel still shows what arrives live.
    realtime.emit('private-channel.7', 'message.created', live(4))
    expect(summary(entries())).toEqual(['1:message 1', '2:message 2', '4:message 4'])
    expect(timeline(channelKey(CHANNEL)).value.refreshFailed).toBe(false)

    // Retried after 1 s (fails again), then after 2 s (succeeds) and repaired.
    await vi.advanceTimersByTimeAsync(999)
    const attempts = () => server.calls.filter((c) => c.path === '/api/v1/channels/7/messages' && c.query.get('after') === null).length
    expect(attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts()).toBe(3)
    await vi.advanceTimersByTimeAsync(2000)
    expect(attempts()).toBe(4)
    expect(summary(entries())).toEqual(['1:edited', '2:message 2', '3:message 3', '4:message 4'])
    expect(timeline(channelKey(CHANNEL)).value.refreshFailed).toBe(false)
  })

  it('says so after a few failures, offers a retry, and stops retrying once the channel is left', async () => {
    vi.useFakeTimers()
    let down = false
    const { chat, server } = setup({
      'GET /api/v1/channels/7/messages': () => (down ? { status: 503 } : { body: { data: [live(1)], has_more: false } }),
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await vi.advanceTimersByTimeAsync(0)
    down = true
    realtime.reconnect()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000 + 2000)
    expect(timeline(channelKey(CHANNEL)).value.refreshFailed).toBe(true)
    expect(FAILURES_BEFORE_NOTICE).toBe(3)

    // The view's Retry goes at once.
    const before = server.calls.length
    down = false
    chat.retryRefresh(CHANNEL)
    await vi.advanceTimersByTimeAsync(0)
    expect(server.calls.length).toBeGreaterThan(before)
    expect(timeline(channelKey(CHANNEL)).value.refreshFailed).toBe(false)

    // Failing again, then leaving: no more requests, refetched on the next opening.
    down = true
    realtime.reconnect()
    await vi.advanceTimersByTimeAsync(0)
    chat.closeChannel(CHANNEL)
    const afterLeaving = server.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(server.calls.length).toBe(afterLeaving)
    expect(timeline(channelKey(CHANNEL)).value.stale).toBe(true)
  })

  it('keeps an event that arrives while a stale channel reloads, and a deletion is not undone by the page', async () => {
    let reconnected = false
    const page = deferred<FakeReply>()
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': () => (reconnected ? page.promise : { body: { data: [live(1), live(2)], has_more: false } }),
      'GET /api/v1/channels/8/messages': () => ({ body: { data: [], has_more: false } }),
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()
    chat.closeChannel(CHANNEL)
    chat.openChannel(8)
    reconnected = true
    realtime.reconnect() // channel 7 is now stale
    await flush()
    chat.closeChannel(8)
    chat.openChannel(CHANNEL) // reload starts
    await flush()

    // The server ran the page's query, then these happened, then the response came.
    realtime.emit('private-channel.7', 'message.created', live(5))
    realtime.emit('private-channel.7', 'message.deleted', tombstone(2))
    page.resolve({ body: { data: [live(1), live(2), live(3)], has_more: false } })
    await flush()
    expect(summary(entries())).toEqual(['1:message 1', '2:deleted', '3:message 3', '5:message 5'])
    expect(timeline(channelKey(CHANNEL)).value.stale).toBe(false)
  })

  it('a POST that fails after the realtime copy confirmed the message leaves it confirmed', async () => {
    const response = deferred<FakeReply>()
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
      'POST /api/v1/channels/7/messages': () => response.promise,
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()
    chat.send(CHANNEL, 'hello')
    realtime.emit('private-channel.7', 'message.created', mine(6))
    response.resolve('network-error')
    await flush()
    expect(summary(entries())).toEqual(['6:hello'])
  })

  it('ignores whatever finishes after stop() (signed out)', async () => {
    const list = deferred<FakeReply>()
    const older = deferred<FakeReply>()
    let first = true
    const { chat } = setup({
      'GET /api/v1/channels': () => (first ? ((first = false), { body: [channel(CHANNEL)] }) : list.promise),
      'GET /api/v1/channels/7/messages': ({ query }) =>
        query.get('before') ? older.promise : { body: { data: [live(10), live(11)], has_more: true } },
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()
    const refreshing = chat.refreshChannels()
    void chat.loadOlder(CHANNEL)
    chat.stop()
    resetChannels()
    list.resolve({ body: [channel(CHANNEL), channel(9)] })
    older.resolve({ body: { data: [live(5)], has_more: false } })
    await refreshing
    await flush()
    expect(channels.value).toEqual([])
    expect(summary(entries())).toEqual(['10:message 10', '11:message 11'])
  })

  it('a join, new channel, conversation or leave answered after stop() changes nothing', async () => {
    const joined = deferred<FakeReply>()
    const created = deferred<FakeReply>()
    const opened = deferred<FakeReply>()
    const left = deferred<FakeReply>()
    const { chat } = setup({
      'POST /api/v1/channels/8/join': () => joined.promise,
      'POST /api/v1/channels': () => created.promise,
      'POST /api/v1/dms': () => opened.promise,
      'POST /api/v1/channels/7/leave': () => left.promise,
    })
    await chat.start()
    const before = channels.value
    const pending = [
      chat.join(8),
      chat.createChannel({ name: 'new', kind: 'public', topic: null }),
      chat.openConversation([2]),
      chat.leave(CHANNEL),
    ]
    await flush()
    // Signed out meanwhile: the answers come to a stopped session.
    chat.stop()
    joined.resolve({ body: channel(8, { name: 'other', is_member: true }) })
    created.resolve({ status: 201, body: channel(30, { name: 'new' }) })
    opened.resolve({ status: 201, body: channel(40, { kind: 'dm', name: null, members: [] }) })
    left.resolve({ status: 204 })
    await Promise.allSettled(pending)
    await flush()
    expect(channels.value).toBe(before)
    expect([...realtime.subscriptions.keys()]).toEqual([])
  })

  it('stops loading older pages by itself after a failure, until asked', async () => {
    let fail = true
    const { chat, server } = setup({
      'GET /api/v1/channels/7/messages': ({ query }) =>
        query.get('before') === null
          ? { body: { data: [live(10)], has_more: true } }
          : fail
            ? { status: 500 }
            : { body: { data: [live(9)], has_more: false } },
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()
    await chat.loadOlder(CHANNEL)
    expect(timeline(channelKey(CHANNEL)).value.olderFailed).toBe(true)
    const olderCalls = () => server.calls.filter((c) => c.query.get('before') !== null).length
    await chat.loadOlder(CHANNEL) // a scroll event
    await chat.loadOlder(CHANNEL)
    expect(olderCalls()).toBe(1)
    fail = false
    await chat.loadOlder(CHANNEL, { force: true }) // the view's Retry
    expect(olderCalls()).toBe(2)
    expect(summary(entries())).toEqual(['9:message 9', '10:message 10'])
    expect(timeline(channelKey(CHANNEL)).value.olderFailed).toBe(false)
  })
})
