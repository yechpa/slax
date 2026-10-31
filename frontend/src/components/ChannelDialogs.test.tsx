import { afterEach, describe, expect, it } from 'vitest'
import type { Channel, ChannelMember } from '../api/types.ts'
import { DANA, ME, NOAM, channel } from '../test/fixtures.ts'
import { mountApp, plain, settle, typeInto, type Mounted } from '../test/mountApp.tsx'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
})

const empty = () => ({ body: { data: [], has_more: false } })
const members: ChannelMember[] = [
  { id: ME.id, name: ME.name, avatar_url: null, role: 'owner' },
  { ...DANA, role: 'member' },
]

async function action(host: HTMLElement, label: string): Promise<HTMLDialogElement> {
  ;[...host.querySelectorAll<HTMLButtonElement>('.nav-item--action')].find((b) => b.textContent?.includes(label))!.click()
  await settle()
  return document.querySelector('dialog')!
}

const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!

describe('channels', () => {
  it("says the server's reason for a refused name, and 'taken' only when it is taken", async () => {
    let refusal = ['The name field format is invalid.']
    app = await mountApp(
      {
        'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' })] }),
        'GET /api/v1/channels/7/messages': empty,
        'POST /api/v1/channels': () => ({ status: 422, body: { message: refusal[0], errors: { name: refusal } } }),
      },
      '/c/7',
    )
    const dialog = await action(app.host, 'New channel')
    const name = dialog.querySelector<HTMLInputElement>('input')!
    typeInto(name, 'ops')
    await settle()
    dialog.querySelector('form')!.requestSubmit()
    await settle()
    expect(plain(dialog.querySelector('.field__error')?.textContent)).toBe('The name field format is invalid.')
    expect(document.activeElement).toBe(name)
    // Changing the name clears it.
    typeInto(name, 'ops-2')
    await settle()
    expect(dialog.querySelector('.field__error')).toBeNull()

    // backend ChannelController::NAME_TAKEN
    refusal = ['The name has already been taken.']
    dialog.querySelector('form')!.requestSubmit()
    await settle()
    expect(plain(dialog.querySelector('.field__error')?.textContent)).toBe('This name is already taken.')
  })

  it('creates a channel: the name is checked as typed, a taken one is said, the new one opens', async () => {
    let attempt = 0
    const sent: unknown[] = []
    app = await mountApp(
      {
        'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' })] }),
        'GET /api/v1/channels/7/messages': empty,
        'GET /api/v1/channels/30/messages': empty,
        'POST /api/v1/channels': ({ body }) => {
          sent.push(body)
          attempt += 1
          return attempt === 1
            ? { status: 422, body: { message: 'taken', errors: { name: ['The name has already been taken.'] } } }
            : { status: 201, body: channel(30, { name: 'release-notes', kind: 'private', topic: 'v1.4' }) }
        },
      },
      '/c/7',
    )
    const dialog = await action(app.host, 'New channel')
    const name = dialog.querySelector<HTMLInputElement>('input')!
    expect(document.activeElement).toBe(name)

    // Capitals and spaces are fixed as typed; what cannot be fixed is explained.
    typeInto(name, 'Release Notes')
    await settle()
    expect(name.value).toBe('release-notes')
    expect(dialog.querySelector('.field__error')).toBeNull()
    typeInto(name, 'release_notes')
    await settle()
    expect(plain(dialog.querySelector('.field__error')?.textContent)).toBe('Use lowercase letters (a–z), digits and dashes only.')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    // Refused before any request.
    dialog.querySelector('form')!.requestSubmit()
    await settle()
    expect(sent).toEqual([])

    typeInto(name, 'release-notes')
    dialog.querySelector<HTMLInputElement>('input[value="private"]')!.click()
    typeInto(dialog.querySelectorAll<HTMLInputElement>('input[type="text"]')[1], '  v1.4  ')
    await settle()
    dialog.querySelector('form')!.requestSubmit()
    await settle()
    expect(plain(dialog.querySelector('.field__error')?.textContent)).toBe('This name is already taken.')

    dialog.querySelector('form')!.requestSubmit()
    await settle()
    expect(sent).toEqual([
      { name: 'release-notes', kind: 'private', topic: 'v1.4' },
      { name: 'release-notes', kind: 'private', topic: 'v1.4' },
    ])
    expect(document.querySelector('dialog')).toBeNull()
    expect(location.pathname).toBe('/c/30')
    expect(app.realtime.subscriptions.has('private-channel.30')).toBe(true)
    expect(plain(app.host.querySelector('.toast--success .toast__text')?.textContent)).toBe('You created #release-notes.')
  })

  it('browses public channels and joins one', async () => {
    app = await mountApp(
      {
        'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' }), channel(8, { name: 'random', is_member: false, topic: 'off-topic' }), channel(9, { name: 'ops', kind: 'private' })] }),
        'GET /api/v1/channels/7/messages': empty,
        'GET /api/v1/channels/8/messages': empty,
        'POST /api/v1/channels/8/join': () => ({ body: channel(8, { name: 'random', is_member: true, topic: 'off-topic' }) }),
      },
      '/c/7',
    )
    const dialog = await action(app.host, 'Browse channels')
    const names = () => [...dialog.querySelectorAll('.browse__name')].map((n) => plain(n.textContent))
    expect(names()).toEqual(['#general', '#random'])
    typeInto(dialog.querySelector('input')!, '#ran')
    await settle()
    expect(names()).toEqual(['#random'])
    button(dialog, 'Join').click()
    await settle()
    expect(location.pathname).toBe('/c/8')
    expect(app.realtime.subscriptions.has('private-channel.8')).toBe(true)
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('browse lists a public channel created by someone else since the list was loaded', async () => {
    let list = [channel(7, { name: 'general' })]
    app = await mountApp(
      {
        'GET /api/v1/channels': () => ({ body: list }),
        'GET /api/v1/channels/7/messages': empty,
      },
      '/c/7',
    )
    // Created elsewhere after start-up: nothing is pushed for it.
    list = [...list, channel(12, { name: 'launch', is_member: false })]
    const dialog = await action(app.host, 'Browse channels')
    await settle()
    expect([...dialog.querySelectorAll('.browse__name')].map((n) => plain(n.textContent))).toEqual(['#general', '#launch'])
  })

  it('shows the members, lets an owner add and remove people, and explains a refused leave', async () => {
    let list = [...members]
    const calls: string[] = []
    app = await mountApp(
      {
        'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general', member_count: list.length })] }),
        'GET /api/v1/channels/7': () => ({ body: channel(7, { name: 'general', member_count: list.length }) }),
        'GET /api/v1/channels/7/messages': empty,
        'GET /api/v1/channels/7/members': () => ({ body: list }),
        'GET /api/v1/users': () => ({ body: [DANA, NOAM] }),
        'POST /api/v1/channels/7/members': ({ body }) => {
          calls.push(`add ${(body as { user_id: number }).user_id}`)
          list = [...list, { ...NOAM, role: 'member' }]
          return { status: 201, body: {} }
        },
        [`DELETE /api/v1/channels/7/members/${DANA.id}`]: () => {
          calls.push(`remove ${DANA.id}`)
          list = list.filter((m) => m.id !== DANA.id)
          return { status: 204 }
        },
        'POST /api/v1/channels/7/leave': () => ({ status: 422, body: { error: 'sole_owner' } }),
      },
      '/c/7',
    )
    app.host.querySelector<HTMLButtonElement>('.channel-header__details')!.click()
    await settle()
    const dialog = document.querySelector('dialog')!
    const shown = () => [...dialog.querySelectorAll('.details__member-name')].map((n) => plain(n.textContent))
    expect(shown()).toEqual(['Alice', 'dana'])
    expect(plain(dialog.querySelector('.details__tag--owner')?.textContent)).toBe('owner')

    // Add: the people already in are not offered.
    const picker = dialog.querySelector<HTMLInputElement>('.people-picker__input')!
    typeInto(picker, 'n')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await settle()
    expect([...dialog.querySelectorAll('[role="option"] .people-picker__name')].map((n) => plain(n.textContent))).toEqual(['נעם'])
    // However many members there are (the list shows 200 at most), the server leaves them out.
    expect(app.server.calls.filter((c) => c.path === '/api/v1/users').map((c) => c.query.get('not_in_channel'))).toEqual(['7'])
    ;(dialog.querySelector('[role="option"]') as HTMLElement).click()
    await settle()
    expect(calls).toEqual([`add ${NOAM.id}`])
    expect(shown()).toEqual(['Alice', 'dana', 'נעם'])
    expect(app.host.querySelector('.channel-header__meta')?.textContent).toContain('3 members')

    // Remove: confirmed first; Cancel changes nothing and gives the focus back.
    const removeDana = () => dialog.querySelector<HTMLButtonElement>(`[aria-label="${'Remove ⁨dana⁩ from the channel'}"]`)!
    const confirm = () => document.querySelector<HTMLDialogElement>('dialog[role="alertdialog"]')
    removeDana().click()
    await settle()
    expect(plain(confirm()?.querySelector('.dialog__title')?.textContent)).toBe('Remove dana from #general?')
    expect(document.activeElement).toBe(button(confirm()!, 'Cancel'))
    button(confirm()!, 'Cancel').click()
    await settle()
    expect(confirm()).toBeNull()
    expect(calls).toEqual([`add ${NOAM.id}`])
    expect(document.activeElement).toBe(removeDana())
    removeDana().click()
    await settle()
    button(confirm()!, 'Remove').click()
    await settle()
    expect(calls).toEqual([`add ${NOAM.id}`, `remove ${DANA.id}`])
    expect(confirm()).toBeNull()
    expect(shown()).toEqual(['Alice', 'נעם'])
    expect(dialog.contains(document.activeElement)).toBe(true)

    // The only owner cannot leave: said in the dialog, which stays.
    button(dialog, 'Leave channel').click()
    await settle()
    expect(plain(dialog.querySelector('[role="alert"]')?.textContent)).toBe("#general has no other owner, so you can't leave it.")
    expect(document.querySelector('dialog')).not.toBeNull()
  })

  it('leaving a public channel keeps it listed, readable, and unsubscribed', async () => {
    const general: Channel = channel(7, { name: 'general' })
    let left = false
    app = await mountApp(
      {
        'GET /api/v1/channels': () => ({ body: [{ ...general, is_member: !left }] }),
        'GET /api/v1/channels/7/messages': empty,
        'GET /api/v1/channels/7/members': () => ({ body: [{ id: 2, name: 'dana', avatar_url: null, role: 'owner' }, { id: ME.id, name: ME.name, avatar_url: null, role: 'member' }] }),
        'POST /api/v1/channels/7/leave': () => {
          left = true
          return { status: 204 }
        },
      },
      '/c/7',
    )
    expect(app.realtime.subscriptions.has('private-channel.7')).toBe(true)
    app.host.querySelector<HTMLButtonElement>('.channel-header__details')!.click()
    await settle()
    button(document.querySelector('dialog')!, 'Leave channel').click()
    await settle()
    expect(document.querySelector('dialog')).toBeNull()
    expect(app.realtime.subscriptions.has('private-channel.7')).toBe(false)
    expect(app.host.querySelector('.join-bar')).not.toBeNull()
    expect(app.host.querySelector('.sidebar a.nav-item--muted')?.getAttribute('href')).toBe('/c/7')
  })
})
