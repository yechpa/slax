/**
 * Message text, rendered as Preact text nodes and a few safe elements: never parsed as
 * HTML, never set through innerHTML. Two things are recognised:
 *
 * - http(s) URLs become links opened in a new tab (`rel="noopener noreferrer nofollow"`),
 *   `dir="ltr"` so a URL keeps its order inside a Hebrew sentence. Any other scheme
 *   (javascript:, data:, …) stays plain text. Trailing punctuation and unbalanced closing
 *   brackets are left out of the link ("(see https://x.test/a)." links https://x.test/a).
 * - `@name` becomes a Mention, and `#channel` (a valid channel name) a ChannelName: sigil
 *   and name in one <bdi>, so a Hebrew sentence never shows "general#".
 */
import { ChannelName } from './ui/ChannelName.tsx'
import { Mention } from './ui/Mention.tsx'

export type Token =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'mention'; text: string; name: string }
  | { type: 'channel'; text: string; name: string }

// A scheme not glued to a preceding letter ("nohttps://"), then anything up to whitespace,
// <>", or an invisible formatting character: zero-width spaces and joiners, bidi marks,
// embeddings, overrides and isolates (an RLO inside a link would reorder what it shows),
// and the BOM. One character class, so matching stays linear however long the text.
const URL_PATTERN = /(?<![\p{L}\p{N}_])https?:\/\/[^\s<>"\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/giu
// "@name" or "#channel" at the start, or after whitespace or an opening bracket/quote (not in
// "mail@example.test" or "a#b"). A channel reference is a whole channel name (backend rule:
// lowercase letters, digits and dashes, 40 at most), not the start of a longer word.
const REFERENCE_PATTERN = /(?<=^|[\s([{"'«])(?:@([\p{L}\p{N}][\p{L}\p{N}_.-]{0,39})|#([a-z0-9][a-z0-9-]{0,39})(?![\p{L}\p{N}_]))/gu
const TRAILING = /[.,:;!?'"»…]$/u
const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let last = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = trimUrl(match[0])
    const href = safeHref(raw)
    if (!href) continue
    const start = match.index
    if (start > last) tokens.push(...mentions(text.slice(last, start)))
    tokens.push({ type: 'link', text: raw, href })
    last = start + raw.length
  }
  if (last < text.length) tokens.push(...mentions(text.slice(last)))
  return tokens
}

function trimUrl(candidate: string): string {
  // Bracket balance counted once, then kept up to date: linear, even for a long run of ")".
  const balance: Record<string, number> = { ')': 0, ']': 0, '}': 0 }
  for (const char of candidate) {
    if (char in balance) balance[char] += 1
    else if (char === '(') balance[')'] -= 1
    else if (char === '[') balance[']'] -= 1
    else if (char === '{') balance['}'] -= 1
  }
  let end = candidate.length
  while (end > 0) {
    const last = candidate[end - 1]
    if (TRAILING.test(last)) {
      end -= 1
    } else if (last in PAIRS && balance[last] > 0) {
      balance[last] -= 1
      end -= 1
    } else break
  }
  return candidate.slice(0, end)
}

/**
 * The normalised URL when it is a plain web address with a host, otherwise null. A URL
 * with user info is not linked: https://google.com@evil.test goes to evil.test.
 */
function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw)
    const web = url.protocol === 'http:' || url.protocol === 'https:'
    return web && url.hostname !== '' && url.username === '' && url.password === '' ? url.href : null
  } catch {
    return null
  }
}

function mentions(text: string): Token[] {
  const tokens: Token[] = []
  let last = 0
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    let token: Token | null = null
    if (match[2] !== undefined) token = { type: 'channel', text: `#${match[2]}`, name: match[2] }
    else {
      const name = (match[1] ?? '').replace(/[.\-_]+$/u, '')
      if (name) token = { type: 'mention', text: `@${name}`, name }
    }
    if (!token) continue
    if (match.index > last) tokens.push({ type: 'text', text: text.slice(last, match.index) })
    tokens.push(token)
    last = match.index + token.text.length
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) })
  return tokens
}

export function RichText({ text }: { text: string }) {
  return (
    <>
      {tokenize(text).map((token, index) => {
        if (token.type === 'link') {
          return (
            <a key={index} href={token.href} target="_blank" rel="noopener noreferrer nofollow" dir="ltr">
              {token.text}
            </a>
          )
        }
        if (token.type === 'mention') return <Mention key={index} name={token.name} />
        if (token.type === 'channel') return <ChannelName key={index} name={token.name} />
        return token.text
      })}
    </>
  )
}
