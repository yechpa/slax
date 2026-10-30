import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientState } from '../api/client.ts'
import { api } from '../api/endpoints.ts'
import type { LiveMessage, Reaction } from '../api/types.ts'
import { DANA, ME, channel, live } from '../test/fixtures.ts'
import { FakeRealtime, deferred, fakeFetch, flush, type FakeHandler, type FakeReply } from '../test/fakes.ts'
import { createChat } from './chat.ts'
import { resetChannels } from './channels.ts'
import { channelKey, resetTimelines, timeline } from './messages.ts'
import { session } from './session.ts'
import { resetUi, toasts } from './ui.ts'

const CHANNEL = 7
let realtime: FakeRealtime

function setup(routes: Record<string, FakeHandler>) {
  const server = fakeFetch({
    'GET /api/v1/channels': () => ({ body: [channel(CHANNEL)] }),
    'GET /api/v1/channels/7/messages': () => ({ body: { data: [withReactions([{ emoji: '👍', count: 1, reacted_by_me: false, user_ids: [DANA.id] }])], has_more: false } }),
    ...routes,
  })
  vi.stubGlobal('fetch', server.fetch)
  return { chat: createChat({ api, realtime }), server }
}

const withReactions = (reactions: Reaction[]): LiveMessage => live(1, { reactions })
const reactionsOf = () => {
  const entry = timeline(channelKey(CHANNEL)).value.entries[0]
  return entry.kind === 'server' && !entry.message.deleted ? entry.message.reactions : []
}
const plain = (text: string) => text.replace(/[⁨⁩]/g, '')
/** "PUT /api/v1/messages/1/reactions/<encoded emoji>", as the fake server sees the path. */
const route = (method: string, emoji: string) => `${method} /api/v1/messages/1/reactions/${encodeURIComponent(emoji)}`

beforeEach(() => {
  realtime = new FakeRealtime()
  session.value = { status: 'signed-in', me: ME }
  resetClientState()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetTimelines()
  resetChannels()
  resetUi()
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
})

describe('reactions', () => {
  it('reaction_toggle_is_optimistic_and_rolls_back_on_error', async () => {
    const put = deferred<FakeReply>()
    const { chat, server } = setup({ [route('PUT', '👍')]: () => put.promise })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()

    // Shown at once, before the server answers.
    const done = chat.toggleReaction(1, '👍')
    expect(reactionsOf()).toEqual([{ emoji: '👍', count: 2, reacted_by_me: true, user_ids: [DANA.id, ME.id] }])
    // A second click while the first is on its way changes nothing.
    void chat.toggleReaction(1, '👍')
    put.resolve({ status: 500, body: { message: 'Server Error' } })
    await done
    // Rolled back, and said.
    expect(reactionsOf()).toEqual([{ emoji: '👍', count: 1, reacted_by_me: false, user_ids: [DANA.id] }])
    expect(toasts.value.map((t) => t.text)).toEqual(['Could not update the reaction. Please try again.'])
    const puts = server.calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0].path).toBe(`/api/v1/messages/1/reactions/${encodeURIComponent('👍')}`)

    // A new emoji (the 21st distinct one) refused by the server: removed, with its own explanation.
    const { chat: other } = setup({
      [route('PUT', '🎉')]: () => ({ status: 422, body: { message: 'too many', errors: { emoji: ['This message already has 20 different emoji.'] } } }),
    })
    resetTimelines()
    await other.start()
    other.openChannel(CHANNEL)
    await flush()
    const adding = other.toggleReaction(1, '🎉')
    expect(reactionsOf().map((r) => r.emoji)).toEqual(['👍', '🎉'])
    await adding
    expect(reactionsOf().map((r) => r.emoji)).toEqual(['👍'])
    expect(plain(toasts.value.at(-1)!.text)).toBe('This message already has 20 different reactions.')
  })

  it('removes my reaction optimistically and takes the server copy on success', async () => {
    const { chat } = setup({
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [withReactions([{ emoji: '🚀', count: 2, reacted_by_me: true, user_ids: [DANA.id, ME.id] }])], has_more: false } }),
      [route('DELETE', '🚀')]: () => ({ body: withReactions([{ emoji: '🚀', count: 1, reacted_by_me: false, user_ids: [DANA.id] }]) }),
    })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()
    const done = chat.toggleReaction(1, '🚀')
    expect(reactionsOf()).toEqual([{ emoji: '🚀', count: 1, reacted_by_me: false, user_ids: [DANA.id] }])
    await done
    expect(reactionsOf()).toEqual([{ emoji: '🚀', count: 1, reacted_by_me: false, user_ids: [DANA.id] }])
  })

  it('reaction_changed_event_is_merged_idempotently', async () => {
    const put = deferred<FakeReply>()
    const { chat } = setup({ [route('PUT', '😀')]: () => put.promise })
    await chat.start()
    chat.openChannel(CHANNEL)
    await flush()

    // Broadcasts say reacted_by_me=false for everyone: mine is read from user_ids.
    const event = withReactions([{ emoji: '👍', count: 2, reacted_by_me: false, user_ids: [DANA.id, ME.id] }])
    realtime.emit('private-channel.7', 'reaction.changed', event)
    const once = timeline(channelKey(CHANNEL)).value.entries
    expect(reactionsOf()).toEqual([{ emoji: '👍', count: 2, reacted_by_me: true, user_ids: [DANA.id, ME.id] }])
    realtime.emit('private-channel.7', 'reaction.changed', event)
    expect(timeline(channelKey(CHANNEL)).value.entries).toBe(once)

    // Beyond the 50 listed reactors, my state is kept from what we knew.
    const many = Array.from({ length: 50 }, (_, i) => 100 + i)
    realtime.emit('private-channel.7', 'reaction.changed', withReactions([{ emoji: '👍', count: 60, reacted_by_me: false, user_ids: many }]))
    expect(reactionsOf()[0]).toMatchObject({ count: 60, reacted_by_me: true })

    // While my own toggle is on its way, an event from someone else never flips my chip.
    realtime.emit('private-channel.7', 'reaction.changed', withReactions([{ emoji: '😀', count: 1, reacted_by_me: false, user_ids: [DANA.id] }]))
    const adding = chat.toggleReaction(1, '😀')
    expect(reactionsOf()[0]).toMatchObject({ emoji: '😀', count: 2, reacted_by_me: true })
    // Someone else reacts too: the server state does not include me yet.
    realtime.emit('private-channel.7', 'reaction.changed', withReactions([{ emoji: '😀', count: 2, reacted_by_me: false, user_ids: [DANA.id, 3] }]))
    expect(reactionsOf()[0]).toEqual({ emoji: '😀', count: 3, reacted_by_me: true, user_ids: [DANA.id, 3, ME.id] })
    // Now it does: no double count.
    realtime.emit('private-channel.7', 'reaction.changed', withReactions([{ emoji: '😀', count: 3, reacted_by_me: false, user_ids: [DANA.id, 3, ME.id] }]))
    expect(reactionsOf()[0]).toEqual({ emoji: '😀', count: 3, reacted_by_me: true, user_ids: [DANA.id, 3, ME.id] })
    // The request then fails, but the server had applied it (the event said so): no rollback.
    put.resolve('network-error')
    await adding
    expect(reactionsOf()[0]).toEqual({ emoji: '😀', count: 3, reacted_by_me: true, user_ids: [DANA.id, 3, ME.id] })
  })
})
