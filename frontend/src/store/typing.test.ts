import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TYPING_EXPIRY_MS, TYPING_THROTTLE_MS, createTyping } from './typing.ts'

const ME = 1
let whispers: { channelId: number; data: unknown }[]
let members: Map<number, number[] | null>

function setup() {
  return createTyping({
    whisper: (channelId, data) => whispers.push({ channelId, data }),
    meId: () => ME,
    membersOf: (channelId) => members.get(channelId) ?? null,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-30T10:00:00Z'))
  whispers = []
  members = new Map()
})

afterEach(() => vi.useRealTimers())

describe('typing', () => {
  it('typing_whispers_are_throttled_and_expire', () => {
    const typing = setup()

    // Outgoing: at most one whisper every 3 s while typing, per place (channel or thread).
    typing.typed(7, null)
    vi.advanceTimersByTime(1000)
    typing.typed(7, null)
    vi.advanceTimersByTime(1000)
    typing.typed(7, null)
    expect(whispers).toEqual([{ channelId: 7, data: { typing: true, parent_id: null } }])
    vi.advanceTimersByTime(TYPING_THROTTLE_MS - 2000)
    typing.typed(7, null)
    typing.typed(7, 40)
    expect(whispers).toHaveLength(3)
    expect(whispers[2]).toEqual({ channelId: 7, data: { typing: true, parent_id: 40 } })

    // Sent or left: one "stopped", and typing again whispers at once.
    typing.stopped(7, null)
    typing.stopped(7, null)
    expect(whispers[3]).toEqual({ channelId: 7, data: { typing: false, parent_id: null } })
    expect(whispers).toHaveLength(4)
    typing.typed(7, null)
    expect(whispers).toHaveLength(5)
    // Nothing to stop when nothing was said lately.
    vi.advanceTimersByTime(TYPING_EXPIRY_MS + 1)
    typing.stopped(7, null)
    expect(whispers).toHaveLength(5)

    // Incoming: shown per place, expiring 5 s after the last whisper of each sender.
    typing.received(7, { typing: true, parent_id: null }, { user_id: '2' })
    vi.advanceTimersByTime(2000)
    typing.received(7, { typing: true, parent_id: null }, { user_id: '3' })
    typing.received(7, { typing: true, parent_id: 40 }, { user_id: '4' })
    expect(typing.typers(7, null).value).toEqual([2, 3])
    expect(typing.typers(7, 40).value).toEqual([4])
    vi.advanceTimersByTime(TYPING_EXPIRY_MS - 2000)
    expect(typing.typers(7, null).value).toEqual([3])
    // A renewed whisper extends it; "stopped" or a message from them clears it.
    typing.received(7, { typing: true, parent_id: null }, { user_id: '3' })
    vi.advanceTimersByTime(4000)
    expect(typing.typers(7, null).value).toEqual([3])
    typing.received(7, { typing: false, parent_id: null }, { user_id: '3' })
    expect(typing.typers(7, null).value).toEqual([])
    typing.noteMessage(7, 4, 40)
    expect(typing.typers(7, 40).value).toEqual([])
  })

  it('never shows me, nor whispers without a sender or from outside a conversation', () => {
    const typing = setup()
    members.set(9, [1, 2])
    typing.received(7, { typing: true, parent_id: null }, { user_id: String(ME) })
    typing.received(7, { typing: true, parent_id: null }, {})
    typing.received(7, 'nonsense', { user_id: '2' })
    typing.received(9, { typing: true, parent_id: null }, { user_id: '5' })
    expect(typing.typers(7, null).value).toEqual([])
    expect(typing.typers(9, null).value).toEqual([])
    typing.received(9, { typing: true, parent_id: null }, { user_id: '2' })
    expect(typing.typers(9, null).value).toEqual([2])
  })
})
