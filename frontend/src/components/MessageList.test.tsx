import { describe, expect, it } from 'vitest'
import { setLocale } from '../i18n/index.ts'
import { mergeMessages, pendingEntry, addPending } from '../store/merge.ts'
import { ME, DANA, live, tombstone } from '../test/fixtures.ts'
import { buildRows } from './MessageList.tsx'

const at = (iso: string) => ({ created_at: iso })
const me = { id: ME.id, name: ME.name, avatar_url: null }

describe('buildRows', () => {
  it('groups by author within 5 minutes, splits days, and places the unread rule', () => {
    setLocale('en')
    const entries = addPending(
      mergeMessages(
        [],
        [
          live(1, { ...at('2026-10-29T15:00:00'), user: DANA }),
          live(2, { ...at('2026-10-30T09:00:00'), user: DANA }),
          live(3, { ...at('2026-10-30T09:04:00'), user: DANA }), // grouped
          live(4, { ...at('2026-10-30T09:10:00'), user: DANA }), // 6 minutes later: new group
          live(5, { ...at('2026-10-30T09:11:00'), user: me }), // mine: never "new"
          tombstone(6, at('2026-10-30T09:12:00')), // deleted: the rule skips it
          live(7, { ...at('2026-10-30T09:13:00'), user: DANA }), // the rule goes here, and breaks the group
          live(8, { ...at('2026-10-30T09:14:00'), user: DANA }), // grouped again
        ],
        ME.id,
      ),
      pendingEntry(7, 'abc', 'on its way', '2026-10-30T09:15:00'),
    )
    const rows = buildRows(entries, ME.id, 4, new Date('2026-10-30T12:00:00'))
    const shape = rows.map((r) => (r.kind === 'entry' ? `${r.key}${r.compact ? '+' : ''}` : r.kind === 'day' ? `[${r.label}]` : '[new]'))
    expect(shape).toEqual(['[yesterday]', 'm:1', '[today]', 'm:2', 'm:3+', 'm:4', 'm:5', 'm:6', '[new]', 'm:7', 'm:8+', 'p:abc'])
  })

  it('places no rule when nothing is unread', () => {
    const entries = mergeMessages([], [live(1), live(2)], ME.id)
    expect(buildRows(entries, ME.id, null).some((r) => r.kind === 'unread')).toBe(false)
    expect(buildRows(entries, ME.id, 2).some((r) => r.kind === 'unread')).toBe(false)
  })
})
