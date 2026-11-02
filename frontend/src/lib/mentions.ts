/**
 * The @mention completion menu, without the DOM: where a mention is being typed, who
 * matches it, what to write for them, and what a key does while the menu is open.
 *
 * It mirrors the server's rule (backend App\Services\Push\Mentions): a mention is `@` at the
 * start or after whitespace or an opening bracket/quote, then a letter or digit and up to 39
 * letters, digits, `_`, `.` or `-`. The server notifies a person named by their first name
 * ("@dana") or by their whole name without spaces ("@DanaCohen"), case-insensitively; two
 * people sharing a first name are both notified by it. So the menu writes the first name,
 * unless another candidate shares it: then the whole name, which picks exactly one person.
 */

/** Someone who can be mentioned: a member of the place, not the author, not banned. */
export interface Candidate {
  id: number
  name: string
}

/** A mention being typed: `@` at `start`, the caret at `end` (after what was typed so far). */
export interface Trigger {
  start: number
  end: number
  /** What follows the `@` up to the caret. */
  query: string
}

export interface Match {
  person: Candidate
  /** What picking them writes after the `@`. */
  handle: string
}

// `@` at the start or after a space or an opening bracket/quote, and the (possibly empty)
// start of a name, ending at the caret. The same characters as Mentions::PATTERN.
const TRIGGER = /(?<=^|[\s([{"'«])@((?:[\p{L}\p{N}][\p{L}\p{N}_.-]{0,39})?)$/u
// A name the server's pattern reads whole, and does not end in a character it drops.
const VALID_HANDLE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,39}$/u
const DROPPED_AT_END = /[._-]$/u
// What is left of a name after the caret when a pick replaces it ("@da|na" → "@Dana ").
const NAME_REST = /^[\p{L}\p{N}_-]*/u

/** The mention being typed just before `caret`, or null when the caret is not in one. */
export function mentionAt(text: string, caret: number): Trigger | null {
  if (caret < 0) return null
  const match = TRIGGER.exec(text.slice(0, caret))
  if (!match) return null
  return { start: match.index, end: caret, query: match[1] }
}

const words = (name: string) => name.trim().split(/\s+/u).filter(Boolean)

/** "Dana Cohen" → "dana": the first name, lowercased. */
const firstName = (name: string) => (words(name)[0] ?? '').toLowerCase()

/** "Dana Cohen" → "DanaCohen". */
const wholeName = (name: string) => words(name).join('')

const usable = (handle: string) => VALID_HANDLE.test(handle) && !DROPPED_AT_END.test(handle)

/**
 * What to write for `person` among `all` (the candidates): the first name, or the whole
 * name without spaces when another candidate has the same first name. Null when neither
 * form is a name the server would read back (an apostrophe in it, say): that person cannot
 * be mentioned by text, so the menu leaves them out rather than write a mention that fails.
 */
export function handleFor(person: Candidate, all: readonly Candidate[]): string | null {
  const first = words(person.name)[0] ?? ''
  const whole = wholeName(person.name)
  const shared = all.some((other) => other.id !== person.id && firstName(other.name) === first.toLowerCase())
  if (!shared && usable(first)) return first
  if (usable(whole)) return whole
  return null
}

/** Whether `query` (already lowercased) starts the person's first name, the whole name, or any word of it. */
function rank(name: string, query: string): number {
  if (query === '') return 0
  const lower = name.toLowerCase()
  const parts = words(lower)
  if ((parts[0] ?? '').startsWith(query)) return 0
  if (parts.join('').startsWith(query)) return 1
  if (parts.some((part) => part.startsWith(query))) return 2
  return -1
}

/**
 * The candidates the typed `query` matches, ignoring case: by first name or whole name
 * (and by any other word of the name, "cohen" for "Dana Cohen"). First names first, then
 * alphabetical. At most `limit`, so the menu stays short on a phone.
 */
export function matchPeople(all: readonly Candidate[], query: string, limit = 8): Match[] {
  const needle = query.toLowerCase()
  const matches: { person: Candidate; handle: string; rank: number }[] = []
  for (const person of all) {
    const r = rank(person.name, needle)
    if (r < 0) continue
    const handle = handleFor(person, all)
    if (handle !== null) matches.push({ person, handle, rank: r })
  }
  matches.sort((a, b) => a.rank - b.rank || a.person.name.localeCompare(b.person.name) || a.person.id - b.person.id)
  return matches.slice(0, limit).map(({ person, handle }) => ({ person, handle }))
}

/**
 * `text` with the typed `@query` replaced by `@handle ` (no second space when one follows),
 * and where the caret goes: after that space. The rest of a name the caret was inside goes too.
 */
export function insertMention(text: string, trigger: Trigger, handle: string): { text: string; caret: number } {
  const rest = text.slice(trigger.end)
  const tail = rest.slice(NAME_REST.exec(rest)?.[0].length ?? 0)
  const spaced = /^\s/u.test(tail) ? '' : ' '
  const before = `${text.slice(0, trigger.start)}@${handle}${spaced}`
  return { text: before + tail, caret: before.length + (spaced === '' ? 1 : 0) }
}

/** What a key does while the menu is (or is not) open. */
export type MenuAction = { type: 'move'; index: number } | { type: 'pick' } | { type: 'close' }

/**
 * The menu's keyboard: ArrowUp/Down move (round the ends), Enter and Tab pick, Escape closes.
 * Null when the key is not the menu's, in particular always when it is closed or has nothing
 * to show: Enter then sends the message, Tab moves on. Shift/Ctrl/Alt/Meta chords and an
 * IME composition are left alone too.
 */
export function menuKey(
  event: { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean },
  open: boolean,
  count: number,
  active: number,
): MenuAction | null {
  if (!open || count === 0 || event.isComposing) return null
  if (event.ctrlKey || event.altKey || event.metaKey) return null
  switch (event.key) {
    case 'ArrowDown':
      return { type: 'move', index: (active + 1) % count }
    case 'ArrowUp':
      return { type: 'move', index: (active - 1 + count) % count }
    case 'Enter':
    case 'Tab':
      // Shift+Enter breaks the line, Shift+Tab goes back: not picks.
      return event.shiftKey ? null : { type: 'pick' }
    case 'Escape':
      return { type: 'close' }
    default:
      return null
  }
}
