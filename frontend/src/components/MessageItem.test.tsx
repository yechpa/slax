import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../i18n/index.ts'
import { live } from '../test/fixtures.ts'
import { MessageItem } from './MessageItem.tsx'
import { tokenize } from './RichText.tsx'

let host: HTMLElement

beforeEach(() => {
  setLocale('en')
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  render(null, host)
  host.remove()
})

const show = (body: string) => render(<MessageItem entry={{ kind: 'server', key: 'm:1', message: live(1, { body }) }} />, host)

describe('message bodies', () => {
  it('renders_mixed_hebrew_english_url_emoji_message_with_dir_auto', () => {
    const url = 'https://grafana.slax.dev/d/k3s?from=now-1h&to=now'
    show(`מעולה, the deploy is green 🚀🎉 ראו ${url}. תודה 👍🏽`)

    const body = host.querySelector('.message__body')!
    expect(body.getAttribute('dir')).toBe('auto')
    expect(body.textContent).toBe(`מעולה, the deploy is green 🚀🎉 ראו ${url}. תודה 👍🏽`)

    const link = body.querySelector('a')!
    expect(link.getAttribute('href')).toBe(url)
    expect(link.textContent).toBe(url)
    // Isolated and left to right: the URL keeps its order inside a Hebrew sentence.
    expect(link.getAttribute('dir')).toBe('ltr')
    // Emoji (including a skin-tone sequence) survive intact, outside the link.
    expect([...body.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('')).toContain('🚀🎉')
    expect(body.textContent).toContain('👍🏽')
    // The author name is isolated too.
    expect(host.querySelector('bdi.message__author')?.textContent).toBe('dana')
  })

  it('urls_are_linkified_safely_and_html_is_never_injected', () => {
    show('<img src=x onerror="alert(1)"> <b>bold</b> javascript:alert(1) data:text/html,<script>x</script> http://ok.test/a')

    const body = host.querySelector('.message__body')!
    // Markup in a message is text, never elements.
    expect(body.querySelector('img, b, script')).toBeNull()
    expect(body.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(body.textContent).toContain('<b>bold</b>')

    // Only http(s) URLs become links, opened safely in a new tab.
    const links = [...body.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['http://ok.test/a'])
    expect(links[0].getAttribute('target')).toBe('_blank')
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer nofollow')
  })

  it('keeps trailing punctuation and closing brackets out of links', () => {
    const links = (text: string) => tokenize(text).filter((t) => t.type === 'link').map((t) => t.text)
    expect(links('see https://a.test/x.')).toEqual(['https://a.test/x'])
    expect(links('(https://a.test/wiki/Foo_(bar)) and https://b.test, ok')).toEqual(['https://a.test/wiki/Foo_(bar)', 'https://b.test'])
    expect(links('"https://a.test/q?x=1"!')).toEqual(['https://a.test/q?x=1'])
    expect(links('nohttps://a.test ftp://a.test https:// http://')).toEqual([])
    expect(links('HTTPS://A.TEST/Path')).toEqual(['HTTPS://A.TEST/Path'])
  })

  it('isolates @mentions as one bidi unit', () => {
    show('ping @נעם and @dana, not mail@example.test')
    expect([...host.querySelectorAll('bdi.mention')].map((m) => m.textContent)).toEqual(['@נעם', '@dana'])
  })

  it('shows tombstones and the edited marker', () => {
    render(<MessageItem entry={{ kind: 'server', key: 'm:1', message: live(1, { edited_at: '2026-10-30T10:00:00Z' }) }} />, host)
    expect(host.querySelector('.message__edited')?.textContent).toBe('(edited)')
    render(
      <MessageItem
        entry={{
          kind: 'server',
          key: 'm:2',
          message: { id: 2, channel_id: 7, parent_id: null, created_at: '2026-10-30T10:00:00Z', reply_count: 0, last_reply_at: null, deleted: true },
        }}
      />,
      host,
    )
    expect(host.querySelector('.tombstone')?.textContent).toContain('This message was deleted.')
  })

  it('ends a URL at bidi and invisible formatting characters', () => {
    const links = (text: string) => tokenize(text).filter((t) => t.type === 'link').map((t) => (t.type === 'link' ? t.href : ''))
    // RLO (U+202E) must not end up inside a link, where it would reorder what is displayed.
    expect(links('see https://good.test/\u202Etxt.exe')).toEqual(['https://good.test/'])
    // RLM before the final full stop: the stop is still trimmed.
    expect(links('ראו https://a.test/x\u200F.')).toEqual(['https://a.test/x'])
    for (const mark of ['\u200B', '\u200C', '\u200D', '\u200E', '\u202A', '\u202B', '\u202C', '\u202D', '\u2066', '\u2067', '\u2068', '\u2069', '\uFEFF']) {
      expect(links(`https://a.test/p${mark}q`)).toEqual(['https://a.test/p'])
    }
  })

  it('does not link a URL carrying user info (https://google.com@evil.test)', () => {
    show('login at https://google.com@evil.test/login or https://user:pw@host.test')
    const body = host.querySelector('.message__body')!
    expect(body.querySelector('a')).toBeNull()
    expect(body.textContent).toContain('https://google.com@evil.test/login')
  })

  it('handles a very long URL quickly and safely', () => {
    const long = `https://a.test/${'x'.repeat(2500)}${')'.repeat(2000)}`
    const started = performance.now()
    const tokens = tokenize(`see ${long}. and ${'(('.repeat(1000)}`)
    const elapsed = performance.now() - started
    expect(tokens.find((t) => t.type === 'link')?.text).toBe(`https://a.test/${'x'.repeat(2500)}`)
    expect(elapsed).toBeLessThan(50)
  })
})
