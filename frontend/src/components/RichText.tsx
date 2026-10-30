/**
 * Message text, rendered as Preact text nodes and a few safe elements: never parsed as
 * HTML, never set through innerHTML. Two things are recognised:
 *
 * - http(s) URLs become links opened in a new tab (`rel="noopener noreferrer nofollow"`),
 *   `dir="ltr"` so a URL keeps its order inside a Hebrew sentence. Any other scheme
 *   (javascript:, data:, …) stays plain text. Trailing punctuation and unbalanced closing
 *   brackets are left out of the link ("(see https://x.test/a)." links https://x.test/a).
 * - `@name` becomes a Mention: sigil and name in one <bdi>.
 */
import { Mention } from './ui/Mention.tsx'

export type Token = { type: 'text'; text: string } | { type: 'link'; text: string; href: string } | { type: 'mention'; text: string; name: string }

// A scheme not glued to a preceding letter ("nohttps://"), then anything up to whitespace or <>".
const URL_PATTERN = /(?<![\p{L}\p{N}_])https?:\/\/[^\s<>"]+/giu
// "@name" at the start, or after whitespace or an opening bracket/quote (not in "mail@example.test").
const MENTION_PATTERN = /(?<=^|[\s([{"'«])@([\p{L}\p{N}][\p{L}\p{N}_.-]{0,39})/gu
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
  let url = candidate
  for (;;) {
    const end = url.at(-1) ?? ''
    if (TRAILING.test(end)) {
      url = url.slice(0, -1)
      continue
    }
    const open = PAIRS[end]
    if (open && count(url, open) < count(url, end)) {
      url = url.slice(0, -1)
      continue
    }
    return url
  }
}

const count = (text: string, char: string) => text.split(char).length - 1

/** The normalised URL when it is a plain web address with a host, otherwise null. */
function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' ? url.href : null
  } catch {
    return null
  }
}

function mentions(text: string): Token[] {
  const tokens: Token[] = []
  let last = 0
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1].replace(/[.\-_]+$/u, '')
    if (!name) continue
    if (match.index > last) tokens.push({ type: 'text', text: text.slice(last, match.index) })
    tokens.push({ type: 'mention', text: `@${name}`, name })
    last = match.index + name.length + 1
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
        return token.text
      })}
    </>
  )
}
