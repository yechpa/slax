import { afterEach, describe, expect, it } from 'vitest'
import type { Channel } from '../api/types.ts'
import { SEARCH_DELAY_MS } from '../lib/search.ts'
import { DANA, ME, NOAM, channel } from '../test/fixtures.ts'
import { deferred, type FakeReply } from '../test/fakes.ts'
import { key, mountApp, plain, settle, typeInto, type Mounted } from '../test/mountApp.tsx'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const dm = (id: number, others = [DANA]): Channel => channel(id, { kind: 'dm', name: null, member_count: 1 + others.length, members: [{ id: ME.id, name: ME.name, avatar_url: null }, ...others] })

async function openDialog(host: HTMLElement): Promise<HTMLInputElement> {
  const action = [...host.querySelectorAll<HTMLButtonElement>('.nav-item--action')].find((b) => b.textContent?.includes('New message'))!
  action.click()
  await settle()
  return document.querySelector<HTMLInputElement>('dialog .people-picker__input')!
}

const options = () => [...document.querySelectorAll('dialog [role="option"] .people-picker__name')].map((o) => plain(o.textContent))
const searches = (mounted: Mounted) => mounted.server.calls.filter((c) => c.path === '/api/v1/users')

describe('new message', () => {
  it('new_dm_dialog_searches_debounced_and_aborts_stale_requests', async () => {
    const answers = new Map<string, ReturnType<typeof deferred<FakeReply>>>()
    app = await mountApp(
      {
        'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' })] }),
        'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
        'GET /api/v1/users': ({ query }) => {
          const answer = deferred<FakeReply>()
          answers.set(query.get('q')!, answer)
          return answer.promise
        },
      },
      '/c/7',
    )
    const input = await openDialog(app.host)
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('role')).toBe('combobox')

    // Typing on: nothing is asked until a pause.
    typeInto(input, 'd')
    typeInto(input, 'da')
    await wait(SEARCH_DELAY_MS / 2)
    typeInto(input, 'dan')
    await wait(SEARCH_DELAY_MS / 2)
    expect(searches(app)).toHaveLength(0)
    await wait(SEARCH_DELAY_MS)
    expect(searches(app).map((c) => c.query.get('q'))).toEqual(['dan'])

    // A new query aborts the one in flight; its late answer is never shown.
    typeInto(input, 'dana')
    const first = app.server.fetch.mock.calls.find(([url]) => String(url).includes('q=dan&') || String(url).endsWith('q=dan'))!
    expect((first[1] as RequestInit).signal?.aborted).toBe(true)
    await wait(SEARCH_DELAY_MS + 20)
    expect(searches(app).map((c) => c.query.get('q'))).toEqual(['dan', 'dana'])
    answers.get('dan')!.resolve({ body: [{ id: 9, name: 'Stale Danny', avatar_url: null }] })
    answers.get('dana')!.resolve({ body: [DANA] })
    await settle()
    expect(options()).toEqual(['dana'])
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(input.getAttribute('aria-activedescendant')).toBe(document.querySelector('dialog [role="option"]')!.id)
  })

  it('dm_creation_handles_200_and_201', async () => {
    let next: { status: number; body: Channel } = { status: 201, body: dm(40) }
    const posted: unknown[] = []
    app = await mountApp(
      {
        'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' }), dm(41, [NOAM])] }),
        'GET /api/v1/channels/7/messages': () => ({ body: { data: [], has_more: false } }),
        'GET /api/v1/channels/40/messages': () => ({ body: { data: [], has_more: false } }),
        'GET /api/v1/channels/41/messages': () => ({ body: { data: [], has_more: false } }),
        'GET /api/v1/users': ({ query }) => ({ body: [DANA, NOAM].filter((p) => p.name.includes(query.get('q')!)) }),
        'POST /api/v1/dms': ({ body }) => {
          posted.push(body)
          return next
        },
      },
      '/c/7',
    )
    const conversations = () => [...app!.host.querySelectorAll('.sidebar a.nav-item')].map((a) => a.getAttribute('href'))

    // 201: a new conversation, listed, subscribed and opened.
    let input = await openDialog(app.host)
    typeInto(input, 'da')
    await wait(SEARCH_DELAY_MS + 30)
    await settle()
    key(input, { key: 'Enter' })
    await settle()
    expect(plain(document.querySelector('dialog .person-chip')?.textContent)).toContain('dana')
    document.querySelector<HTMLFormElement>('dialog form')!.requestSubmit()
    await settle()
    expect(posted).toEqual([{ user_ids: [DANA.id] }])
    expect(location.pathname).toBe('/c/40')
    expect(conversations()).toEqual(['/c/7', '/c/41', '/c/40'])
    expect(app.realtime.subscriptions.has('private-channel.40')).toBe(true)
    expect(document.querySelector('dialog')).toBeNull()

    // 200: the existing one, opened, not listed twice.
    next = { status: 200, body: dm(41, [NOAM]) }
    input = await openDialog(app.host)
    typeInto(input, 'נ')
    await wait(SEARCH_DELAY_MS + 30)
    await settle()
    key(input, { key: 'Enter' })
    await settle()
    document.querySelector<HTMLFormElement>('dialog form')!.requestSubmit()
    await settle()
    expect(location.pathname).toBe('/c/41')
    expect(conversations()).toEqual(['/c/7', '/c/41', '/c/40'])

    // A refusal is said in the dialog, which stays open.
    next = { status: 422, body: { error: 'invalid_participants' } as never }
    input = await openDialog(app.host)
    typeInto(input, 'da')
    await wait(SEARCH_DELAY_MS + 30)
    await settle()
    key(input, { key: 'Enter' })
    await settle()
    document.querySelector<HTMLFormElement>('dialog form')!.requestSubmit()
    await settle()
    expect(plain(document.querySelector('dialog [role="alert"]')?.textContent)).toBe('One of these people can no longer receive messages.')
  })
})
