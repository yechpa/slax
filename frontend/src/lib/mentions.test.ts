import { describe, expect, it } from 'vitest'
import { handleFor, insertMention, matchPeople, mentionAt, menuKey, type Candidate } from './mentions.ts'

const people: Candidate[] = [
  { id: 1, name: 'Dana Cohen' },
  { id: 2, name: 'Dana Levi' },
  { id: 3, name: 'Yossi Mizrahi' },
  { id: 4, name: 'Émilie Durand' },
  { id: 5, name: 'דנה כהן' },
]

describe('mentionAt: where a mention is being typed (the server rule)', () => {
  it('opens on a bare @ at the start, with an empty query', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, end: 1, query: '' })
  })

  it('opens after a space, a newline and an opening bracket or quote', () => {
    for (const before of [' ', '\n', '(', '[', '{', '"', "'", '«']) {
      expect(mentionAt(`hi${before}@da`, 5 + before.length - 1 + 1)).toEqual({ start: 2 + before.length, end: 5 + before.length, query: 'da' })
    }
  })

  it('does not open inside a word or an e-mail address', () => {
    expect(mentionAt('mail@example', 12)).toBeNull()
    expect(mentionAt('a@', 2)).toBeNull()
    expect(mentionAt('@@', 2)).toBeNull()
  })

  it('reads only what is before the caret', () => {
    expect(mentionAt('hi @dana, how', 8)).toEqual({ start: 3, end: 8, query: 'dana' })
    expect(mentionAt('hi @dana, how', 6)).toEqual({ start: 3, end: 6, query: 'da' })
    expect(mentionAt('hi @dana, how', 3)).toBeNull()
    expect(mentionAt('hi @dana, how', 1)).toBeNull()
  })

  it('closes once the name is over: a space, punctuation, or a name the server would cut', () => {
    expect(mentionAt('hi @dana ', 9)).toBeNull()
    expect(mentionAt('hi @dana,', 9)).toBeNull()
    expect(mentionAt('hi @dana!', 9)).toBeNull()
    expect(mentionAt(`@${'a'.repeat(41)}`, 42)).toBeNull()
    expect(mentionAt(`@${'a'.repeat(40)}`, 41)?.query).toBe('a'.repeat(40))
  })

  it('takes letters of any script, digits and _ . - in the name', () => {
    expect(mentionAt('@דנ', 3)?.query).toBe('דנ')
    expect(mentionAt('@Émi', 4)?.query).toBe('Émi')
    expect(mentionAt('@jean-luc', 9)?.query).toBe('jean-luc')
    expect(mentionAt('@a.b_c9', 7)?.query).toBe('a.b_c9')
  })

  it('does not take a name that starts with punctuation', () => {
    expect(mentionAt('@-', 2)).toBeNull()
    expect(mentionAt('@_a', 3)).toBeNull()
  })

  it('finds the mention under the caret among several', () => {
    expect(mentionAt('@yossi and @da', 14)).toEqual({ start: 11, end: 14, query: 'da' })
    expect(mentionAt('@yossi and @da', 6)).toEqual({ start: 0, end: 6, query: 'yossi' })
  })
})

describe('handleFor: what picking someone writes', () => {
  it('is the first name when nobody else has it', () => {
    expect(handleFor(people[2], people)).toBe('Yossi')
    expect(handleFor(people[3], people)).toBe('Émilie')
    expect(handleFor(people[4], people)).toBe('דנה')
  })

  it('is the whole name without spaces when another candidate shares the first name', () => {
    expect(handleFor(people[0], people)).toBe('DanaCohen')
    expect(handleFor(people[1], people)).toBe('DanaLevi')
  })

  it('compares first names ignoring case', () => {
    const list = [{ id: 1, name: 'dana Cohen' }, { id: 2, name: 'DANA Levi' }]
    expect(handleFor(list[0], list)).toBe('danaCohen')
  })

  it('goes back to the first name when the other Dana is not a candidate (not a member, the author)', () => {
    expect(handleFor(people[0], [people[0], people[2]])).toBe('Dana')
  })

  it('resolves, on the server, to exactly the intended person', () => {
    // The server: a token names a person by first name or whole name without spaces, ignoring case.
    const resolves = (token: string, name: string) => {
      const words = name.trim().split(/\s+/)
      return [words[0], words.join('')].map((s) => s.toLowerCase()).includes(token.toLowerCase())
    }
    for (const person of people) {
      const handle = handleFor(person, people)!
      expect(people.filter((p) => resolves(handle, p.name)).map((p) => p.id)).toEqual([person.id])
    }
  })

  it('is null when the server could not read the name back', () => {
    // An apostrophe ends the server's token ("@O'Brien" would name "o"): neither form is readable.
    const list = [{ id: 1, name: "O'Brien Conan" }]
    expect(handleFor(list[0], list)).toBeNull()
    expect(handleFor({ id: 2, name: "D'Arcy Smith" }, [{ id: 2, name: "D'Arcy Smith" }])).toBeNull()
    expect(handleFor({ id: 3, name: '😀 Smile' }, [{ id: 3, name: '😀 Smile' }])).toBeNull()
  })

  it('uses the whole name when only the first name is unusable', () => {
    // "Jo." is cut to "Jo" by the server, which is no name; "Jo.Smith" is read whole.
    const list = [{ id: 1, name: 'Jo. Smith' }]
    expect(handleFor(list[0], list)).toBe('Jo.Smith')
  })

  it('is null for a name longer than the server reads', () => {
    const long = { id: 1, name: 'x'.repeat(41) }
    expect(handleFor(long, [long])).toBeNull()
  })
})

describe('matchPeople: filtering as the user types', () => {
  const names = (query: string, list = people) => matchPeople(list, query).map((m) => m.person.name)

  it('lists everybody, by name, for a bare @', () => {
    expect(names('')).toEqual(['Dana Cohen', 'Dana Levi', 'דנה כהן', 'Yossi Mizrahi', 'Émilie Durand'].sort((a, b) => a.localeCompare(b)))
  })

  it('matches the start of the first name, ignoring case', () => {
    expect(names('da')).toEqual(['Dana Cohen', 'Dana Levi'])
    expect(names('DA')).toEqual(['Dana Cohen', 'Dana Levi'])
    expect(names('yo')).toEqual(['Yossi Mizrahi'])
  })

  it('matches the whole name typed without its space, and the other words of the name', () => {
    expect(names('danac')).toEqual(['Dana Cohen'])
    expect(names('DanaLevi')).toEqual(['Dana Levi'])
    expect(names('mizr')).toEqual(['Yossi Mizrahi'])
  })

  it('puts first-name matches before the others', () => {
    const list = [{ id: 1, name: 'Anna Dana' }, { id: 2, name: 'Dana Cohen' }]
    expect(names('dana', list)).toEqual(['Dana Cohen', 'Anna Dana'])
  })

  it('matches accents and Hebrew as typed', () => {
    expect(names('ém')).toEqual(['Émilie Durand'])
    expect(names('דנ')).toEqual(['דנה כהן'])
  })

  it('finds nobody for a stranger', () => {
    expect(names('zzz')).toEqual([])
  })

  it('carries the handle to write, disambiguated among all candidates, not only the matches', () => {
    const [match] = matchPeople(people, 'danac')
    expect(match.handle).toBe('DanaCohen')
    expect(matchPeople(people, 'yo')[0].handle).toBe('Yossi')
  })

  it('leaves out who cannot be mentioned by text', () => {
    const list = [{ id: 1, name: "O'Brien Conan" }, { id: 2, name: 'Dana Cohen' }]
    expect(names('', list)).toEqual(['Dana Cohen'])
  })

  it('shows at most `limit` people', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `Person${String(i).padStart(2, '0')} X` }))
    expect(matchPeople(many, '')).toHaveLength(8)
    expect(matchPeople(many, '', 3)).toHaveLength(3)
  })

  it('does not change the list it is given', () => {
    const copy = structuredClone(people)
    matchPeople(people, '')
    expect(people).toEqual(copy)
  })
})

describe('insertMention: writing the pick', () => {
  it('replaces the typed @query by @handle and a space; the caret goes after the space', () => {
    const trigger = mentionAt('hi @da', 6)!
    expect(insertMention('hi @da', trigger, 'Dana')).toEqual({ text: 'hi @Dana ', caret: 9 })
  })

  it('works on a bare @ at the start', () => {
    expect(insertMention('@', mentionAt('@', 1)!, 'Yossi')).toEqual({ text: '@Yossi ', caret: 7 })
  })

  it('keeps the text after the caret, and does not double an existing space', () => {
    const text = 'hi @da and more'
    const trigger = mentionAt(text, 6)!
    expect(insertMention(text, trigger, 'Dana')).toEqual({ text: 'hi @Dana and more', caret: 9 })
  })

  it('adds the space before what follows when it is not one', () => {
    const text = 'hi @da,'
    expect(insertMention(text, mentionAt(text, 6)!, 'Dana')).toEqual({ text: 'hi @Dana ,', caret: 9 })
  })

  it('replaces the rest of a name the caret was inside', () => {
    const text = 'hi @dana rest'
    expect(insertMention(text, mentionAt(text, 6)!, 'DanaCohen')).toEqual({ text: 'hi @DanaCohen rest', caret: 14 })
  })

  it('the mention it writes is a mention again, for the server and RichText', () => {
    const { text } = insertMention('ping @y', mentionAt('ping @y', 7)!, 'Yossi')
    expect(text).toBe('ping @Yossi ')
    expect(mentionAt(text.trimEnd(), text.trimEnd().length)?.query).toBe('Yossi')
  })
})

describe('menuKey: the keyboard of the open menu', () => {
  const key = (k: string, extra: object = {}) => ({ key: k, ...extra })

  it('ArrowDown and ArrowUp move, round the ends', () => {
    expect(menuKey(key('ArrowDown'), true, 3, 0)).toEqual({ type: 'move', index: 1 })
    expect(menuKey(key('ArrowDown'), true, 3, 2)).toEqual({ type: 'move', index: 0 })
    expect(menuKey(key('ArrowUp'), true, 3, 0)).toEqual({ type: 'move', index: 2 })
    expect(menuKey(key('ArrowUp'), true, 3, 2)).toEqual({ type: 'move', index: 1 })
  })

  it('Enter and Tab pick, Escape closes', () => {
    expect(menuKey(key('Enter'), true, 2, 1)).toEqual({ type: 'pick' })
    expect(menuKey(key('Tab'), true, 2, 1)).toEqual({ type: 'pick' })
    expect(menuKey(key('Escape'), true, 2, 0)).toEqual({ type: 'close' })
  })

  it('does not swallow anything while closed or empty: Enter sends, Tab moves on', () => {
    for (const k of ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown']) {
      expect(menuKey(key(k), false, 3, 0)).toBeNull()
      expect(menuKey(key(k), true, 0, 0)).toBeNull()
    }
  })

  it('leaves other keys, chords and IME confirmations alone', () => {
    expect(menuKey(key('a'), true, 3, 0)).toBeNull()
    expect(menuKey(key('ArrowLeft'), true, 3, 0)).toBeNull()
    expect(menuKey(key('Enter', { shiftKey: true }), true, 3, 0)).toBeNull()
    expect(menuKey(key('Tab', { shiftKey: true }), true, 3, 0)).toBeNull()
    expect(menuKey(key('Enter', { ctrlKey: true }), true, 3, 0)).toBeNull()
    expect(menuKey(key('Enter', { isComposing: true }), true, 3, 0)).toBeNull()
  })
})
