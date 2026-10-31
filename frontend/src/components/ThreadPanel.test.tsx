import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../api/types.ts'
import { navigate } from '../router.ts'
import { ME, channel, live, tombstone } from '../test/fixtures.ts'
import type { FakeHandler } from '../test/fakes.ts'
import { key, mountApp, plain, settle, typeInto, type Mounted } from '../test/mountApp.tsx'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
})

const at = (minute: number) => `2026-10-30T09:${String(minute).padStart(2, '0')}:00.000Z`

function routes(parent: Message = live(10, { body: 'the parent', reply_count: 2, last_reply_at: at(12) })): Record<string, FakeHandler> {
  return {
    'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' })] }),
    'GET /api/v1/channels/7/messages': () => ({ body: { data: [parent, live(20, { body: 'later' })], has_more: false } }),
    'GET /api/v1/messages/10/replies': () => ({
      body: {
        parent,
        data: [live(11, { parent_id: 10, body: 'first reply', created_at: at(11) }), live(12, { parent_id: 10, body: 'second reply', created_at: at(12) })],
        has_more: false,
      },
    }),
  }
}

const panel = () => document.querySelector<HTMLElement>('.thread')

describe('thread panel', () => {
  it('deleted_parent_shows_tombstone_and_replies', async () => {
    app = await mountApp(routes(tombstone(10, { reply_count: 2, last_reply_at: at(12) })), '/c/7')
    // In the channel, the tombstone keeps its thread link.
    const link = app.host.querySelector<HTMLAnchorElement>('.message--deleted .thread-link')!
    expect(plain(link.textContent)).toContain('2 replies')
    expect(link.getAttribute('href')).toBe('/c/7/t/10')

    link.click()
    await settle()
    expect(location.pathname).toBe('/c/7/t/10')
    const thread = panel()!
    expect(thread.querySelector('.thread__parent .tombstone')?.textContent).toContain('This message was deleted.')
    expect([...thread.querySelectorAll('.message-list__row .message__body')].map((b) => b.textContent)).toEqual(['first reply', 'second reply'])
    expect(plain(thread.querySelector('.divider')?.textContent)).toContain('2 replies')
    // Replies can still be written to it.
    expect(thread.querySelector('textarea')).not.toBeNull()
  })

  it('shows replies arriving live and the parent summary in the channel follows', async () => {
    app = await mountApp(routes(), '/c/7/t/10')
    app.realtime.emit('private-channel.7', 'message.created', live(13, { parent_id: 10, body: 'third reply', created_at: at(13) }))
    await settle()
    expect([...panel()!.querySelectorAll('.message-list__row .message__body')].map((b) => b.textContent)).toEqual(['first reply', 'second reply', 'third reply'])
    const summary = app.host.querySelector('.message-list .thread-link')
    expect(plain(summary?.textContent)).toContain('3 replies')
  })

  it('thread_panel_traps_focus_and_escape_closes', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('64rem'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
    app = await mountApp(routes(), '/c/7')
    const opener = app.host.querySelector<HTMLAnchorElement>('.message-list .thread-link')!
    opener.focus()
    opener.click()
    await settle()

    const thread = panel()!
    expect(thread.getAttribute('role')).toBe('dialog')
    expect(thread.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(thread.querySelector('.thread__title'))
    // Everything else is out of reach.
    expect((app.host.querySelector('.sidebar') as HTMLElement & { inert: boolean }).inert).toBe(true)
    expect((app.host.querySelector('.channel-header') as HTMLElement & { inert: boolean }).inert).toBe(true)
    expect((app.host.querySelector('.message-pane') as HTMLElement & { inert: boolean }).inert).toBe(true)
    expect((app.host.querySelector('.shell__footer') as HTMLElement & { inert: boolean }).inert).toBe(true)

    // Tab cycles inside: from the last element to the first, and back.
    const focusables = [...thread.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea, [tabindex="0"]')]
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    last.focus()
    key(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    key(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    // Escape (even from the composer) closes it, and focus goes back to what opened it.
    const textarea = thread.querySelector('textarea')!
    textarea.focus()
    key(textarea, { key: 'Escape' })
    await settle()
    expect(panel()).toBeNull()
    expect(location.pathname).toBe('/c/7')
    expect(document.activeElement).toBe(app.host.querySelector('.message-list .thread-link'))
    expect((app.host.querySelector('.sidebar') as HTMLElement & { inert: boolean }).inert).toBe(false)
  })

  it('replies from its own composer, with the parent id', async () => {
    const r = routes()
    r['POST /api/v1/channels/7/messages'] = ({ body }) => {
      const sent = body as { body: string; client_id: string; parent_id: number }
      return { status: 201, body: live(14, { parent_id: sent.parent_id, body: sent.body, client_id: sent.client_id, user: { id: ME.id, name: ME.name, avatar_url: null }, created_at: at(14) }) }
    }
    app = await mountApp(r, '/c/7')
    navigate('/c/7/t/10')
    await settle()
    const textarea = panel()!.querySelector('textarea')!
    typeInto(textarea, 'on it')
    await settle()
    key(textarea, { key: 'Enter' })
    await settle()
    const post = app.server.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/channels/7/messages')
    expect(post?.body).toMatchObject({ body: 'on it', parent_id: 10 })
    expect([...panel()!.querySelectorAll('.message-list__row .message__body')].map((b) => b.textContent)).toEqual(['first reply', 'second reply', 'on it'])
    // Not in the channel's own list.
    expect([...app.host.querySelectorAll('.message-list .message__body')].map((b) => b.textContent)).toEqual(['the parent', 'later'])
    expect(plain(app.host.querySelector('.message-list .thread-link')?.textContent)).toContain('3 replies')
  })
})
