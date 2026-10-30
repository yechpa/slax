import { describe, expect, it } from 'vitest'
import type { Message } from '../api/types.ts'
import { live, tombstone } from '../test/fixtures.ts'
import { addPending, mergeMessages, pendingEntry, resetTo, type Entry } from './merge.ts'

const ME = 1
const OTHER = 2

const ids = (entries: Entry[]) => entries.map((e) => (e.kind === 'server' ? e.message.id : e.clientId))

describe('mergeMessages', () => {
  it('message_merge_is_idempotent_and_ordered', () => {
    const page: Message[] = [live(5), live(3), live(9), live(4)]
    const once = mergeMessages([], page, ME)
    expect(ids(once)).toEqual([3, 4, 5, 9])

    // Merging the same data again changes nothing, not even the array identity.
    expect(mergeMessages(once, page, ME)).toBe(once)
    expect(mergeMessages(once, [live(4)], ME)).toBe(once)

    // Overlapping pages, in any order, give one ordered copy of each message.
    const older = [live(1), live(2), live(3)]
    const newer = [live(9), live(10), live(4)]
    const a = mergeMessages(mergeMessages(once, older, ME), newer, ME)
    const b = mergeMessages(mergeMessages(once, newer, ME), older, ME)
    expect(ids(a)).toEqual([1, 2, 3, 4, 5, 9, 10])
    expect(b).toEqual(a)
    expect(new Set(ids(a)).size).toBe(a.length)

    // Pending messages stay after every server message, in the order they were written.
    const withPending = addPending(addPending(a, pendingEntry(7, 'bbb', 'second', '2026-10-30T10:00:01Z')), pendingEntry(7, 'aaa', 'third', '2026-10-30T10:00:02Z'))
    const merged = mergeMessages(withPending, [live(11), live(6)], ME)
    expect(ids(merged)).toEqual([1, 2, 3, 4, 5, 6, 9, 10, 11, 'bbb', 'aaa'])
    expect(mergeMessages(merged, [live(11), live(6)], ME)).toBe(merged)
  })

  it('replaces a pending message by its server copy (same client_id, mine only)', () => {
    const entries = addPending(mergeMessages([], [live(1)], ME), pendingEntry(7, 'abc', 'hello', '2026-10-30T10:00:00Z'))
    const notMine = mergeMessages(entries, [live(2, { client_id: 'abc', user: { id: OTHER, name: 'x', avatar_url: null } })], ME)
    expect(ids(notMine)).toEqual([1, 2, 'abc'])

    const confirmed = mergeMessages(entries, [live(2, { client_id: 'ABC', user: { id: ME, name: 'me', avatar_url: null } })], ME)
    expect(ids(confirmed)).toEqual([1, 2])
  })

  it('never resurrects a tombstone or rolls an edit back with an older snapshot', () => {
    const edited = live(1, { body: 'v2', edited_at: '2026-10-30T10:05:00Z' })
    let entries = mergeMessages([], [edited, tombstone(2)], ME)

    entries = mergeMessages(entries, [live(1, { body: 'v1' }), live(2)], ME)
    expect(entries.map((e) => (e.kind === 'server' && !e.message.deleted ? e.message.body : 'deleted'))).toEqual(['v2', 'deleted'])

    const newer = live(1, { body: 'v3', edited_at: '2026-10-30T10:06:00Z' })
    entries = mergeMessages(entries, [newer], ME)
    expect(entries[0].kind === 'server' && entries[0].message).toEqual(newer)
  })
})

describe('resetTo', () => {
  it('swaps the window for a fresh page, keeping newer messages and pending ones', () => {
    const entries = addPending(mergeMessages([], [live(1), live(2), live(50)], ME), pendingEntry(7, 'p', 'x', '2026-10-30T10:00:00Z'))
    expect(ids(resetTo(entries, [live(20), live(21)], ME))).toEqual([20, 21, 50, 'p'])
  })
})

describe('resetTo keeps what is fresher than the page', () => {
  it('never resurrects a message deleted while the page was on its way, nor rolls back an edit', () => {
    const entries = mergeMessages([], [live(1), tombstone(2), live(3, { body: 'v2', edited_at: '2026-10-30T10:05:00Z' })], ME)
    // The page's snapshot was taken before the deletion and the edit.
    const reset = resetTo(entries, [live(1), live(2), live(3, { body: 'v1' }), live(4)], ME)
    expect(reset.map((e) => (e.kind === 'server' ? (e.message.deleted ? `${e.message.id}:deleted` : `${e.message.id}:${e.message.body}`) : e.key))).toEqual([
      '1:message 1',
      '2:deleted',
      '3:v2',
      '4:message 4',
    ])
  })
})
