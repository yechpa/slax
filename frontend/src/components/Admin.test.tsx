import { afterEach, describe, expect, it } from 'vitest'
import type { AdminStatus, AuditPage, Me } from '../api/types.ts'
import { setLocale } from '../i18n/index.ts'
import { SEARCH_DELAY_MS } from '../lib/search.ts'
import { route } from '../router.ts'
import { DANA, ME, channel, live } from '../test/fixtures.ts'
import type { FakeHandler } from '../test/fakes.ts'
import { key, mountApp, plain, settle, typeInto, type Mounted } from '../test/mountApp.tsx'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
})

const ADMIN: Me = { ...ME, is_admin: true }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const STATUS: AdminStatus = {
  environment: 'Dev',
  checked_at: '2026-10-30T10:00:00.000Z',
  services: [
    { name: 'database', status: 'ok', latency_ms: 2 },
    { name: 'redis', status: 'ok', latency_ms: 1 },
    { name: 'reverb', status: 'degraded', latency_ms: 2001 },
    { name: 'scanner', status: 'ok', latency_ms: 12 },
    { name: 's3', status: 'ok', latency_ms: 30 },
  ],
}

const AUDIT: AuditPage = {
  data: [
    { id: 3, action: 'user.banned', created_at: '2026-10-30T09:59:00.000Z', ip: '10.0.0.1', actor: { id: ME.id, name: ME.name }, target: { type: 'user', id: 9, label: 'Mallory' } },
    { id: 2, action: 'auth.sign_in_failed.invalid_state', created_at: '2026-10-30T09:58:00.000Z', ip: '10.0.0.2', actor: null, target: null },
  ],
  page: 1,
  per_page: 50,
  has_more: true,
}

const general = channel(7, { name: 'general' })
const theirs = live(2, { body: 'spam spam', files: [{ id: 40, name: 'junk.pdf', mime: 'application/pdf', size: 10, kind: 'pdf', download_url: '/api/v1/files/40/download' }] })

function routes(me: Me, extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /api/v1/me': () => ({ body: me }),
    'GET /api/v1/channels': () => ({ body: [general, channel(8, { name: 'random', locked: true })] }),
    'GET /api/v1/channels/7/messages': () => ({ body: { data: [theirs], has_more: false } }),
    'GET /api/v1/admin/status': () => ({ body: STATUS }),
    'GET /api/v1/admin/audit': ({ query }) => ({ body: { ...AUDIT, page: Number(query.get('page')), has_more: query.get('page') === '1' } }),
    'GET /api/v1/admin/users/banned': () => ({ body: { data: [] } }),
    ...extra,
  }
}

const adminCalls = (mounted: Mounted) => mounted.server.calls.filter((c) => c.path.startsWith('/api/v1/admin'))

async function openUserMenu(host: HTMLElement): Promise<void> {
  host.querySelector<HTMLButtonElement>('.user-menu__toggle')!.click()
  await settle()
}

async function openMessageMenu(host: HTMLElement): Promise<string[]> {
  host.querySelector<HTMLButtonElement>('.message-list .message-item .message-actions__more')?.click()
  await settle()
  return [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((m) => plain(m.textContent))
}

const tab = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === name)!

describe('administration', () => {
  it('a non-administrator never sees an admin entry point, and /admin shows nothing of it', async () => {
    app = await mountApp(routes(ME), '/c/7')

    await openUserMenu(app.host)
    expect(app.host.querySelector('.user-menu__admin')).toBeNull()
    expect(app.host.textContent).not.toContain('Administration')

    // Someone else's message: no moderation in its menu (there is no other item for a non-member either).
    expect(await openMessageMenu(app.host)).toEqual(['Reply in thread', 'Add reaction'])
    key(document.activeElement!, { key: 'Escape' })
    await settle()

    // Typing the address: a refusal, and not a single admin call.
    history.pushState(null, '', '/admin')
    route.value = { name: 'admin' }
    await settle()
    expect(plain(app.host.querySelector('.shell__main')?.textContent)).toContain('This page is for administrators only.')
    expect(app.host.querySelector('[role="tablist"]')).toBeNull()
    expect(adminCalls(app)).toEqual([])
  })

  it('an administrator opens the status and the audit log from the account menu', async () => {
    app = await mountApp(routes(ADMIN), '/c/7')

    await openUserMenu(app.host)
    const link = app.host.querySelector<HTMLAnchorElement>('.user-menu__admin')!
    expect(link.textContent).toBe('Administration')
    link.click()
    await settle()
    expect(location.pathname).toBe('/admin')
    expect(app.host.querySelector('#channel-title')?.textContent).toBe('Administration')

    // Status first: every service, the degraded one said in words.
    const rows = [...app.host.querySelectorAll('.admin-status__row')]
    expect(rows.map((r) => plain(r.querySelector('.admin-status__name')?.textContent))).toEqual([
      'Database (PostgreSQL)',
      'Cache and queues (Redis)',
      'Realtime (Reverb)',
      'Upload scanner',
      'File storage (S3)',
    ])
    expect(plain(rows[2].textContent)).toContain('degraded')
    expect(plain(rows[2].textContent)).toContain('2,001 ms')
    expect(rows[2].classList.contains('admin-status__row--degraded')).toBe(true)

    // Tabs: arrows move between them.
    const status = tab(app.host, 'Status')
    expect(status.getAttribute('aria-selected')).toBe('true')
    status.focus()
    key(status, { key: 'ArrowRight' })
    await settle()
    expect(tab(app.host, 'Audit log').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab(app.host, 'Audit log'))

    const lines = [...app.host.querySelectorAll('.admin-table tbody tr')].map((r) => plain(r.textContent))
    expect(lines[0]).toContain('Banned')
    expect(lines[0]).toContain('Mallory')
    expect(lines[0]).toContain('Alice')
    expect(lines[1]).toContain('Failed sign-in (invalid_state)')
    expect(lines[1]).toContain('system')

    // Paged, newest first.
    ;[...app.host.querySelectorAll<HTMLButtonElement>('.admin__pager button')].find((b) => b.textContent === 'Older')!.click()
    await settle()
    expect(app.server.calls.filter((c) => c.path === '/api/v1/admin/audit').map((c) => c.query.get('page'))).toEqual(['1', '2'])
    expect(plain(app.host.querySelector('.admin__bar .admin__note')?.textContent)).toBe('Page 2')
  })

  it('bans someone picked from the directory, after a confirmation, and can lift it', async () => {
    const bans: unknown[] = []
    app = await mountApp(
      routes(ADMIN, {
        'GET /api/v1/users': () => ({ body: [DANA] }),
        'POST /api/v1/admin/users/2/ban': ({ body }) => {
          bans.push(body)
          const banned = (body as { banned: boolean }).banned
          return { body: { ...DANA, banned, banned_at: banned ? '2026-10-30T10:00:00.000Z' : null } }
        },
      }),
      '/admin',
    )
    tab(app.host, 'Moderation').click()
    await settle()
    expect(plain(app.host.textContent)).toContain('Nobody is banned.')

    const input = app.host.querySelector<HTMLInputElement>('.admin__ban .people-picker__input')!
    typeInto(input, 'da')
    await wait(SEARCH_DELAY_MS + 20)
    await settle()
    key(input, { key: 'Enter' })
    await settle()
    const ban = [...app.host.querySelectorAll<HTMLButtonElement>('.admin__ban button')].find((b) => b.textContent === 'Ban')!
    expect(ban.disabled).toBe(false)
    ban.click()
    await settle()

    const dialog = document.querySelector('dialog[open]')!
    expect(plain(dialog.querySelector('.dialog__title')?.textContent)).toBe('Ban dana?')
    expect(bans).toEqual([])
    ;[...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Ban')!.click()
    await settle()

    expect(bans).toEqual([{ banned: true }])
    expect(plain(app.host.querySelector('.toast--success .toast__text')?.textContent)).toBe('dana is banned.')
    expect([...app.host.querySelectorAll('.admin-list__name')].map((n) => plain(n.textContent))).toContain('dana')

    ;[...app.host.querySelectorAll<HTMLButtonElement>('.admin-list__row button')].find((b) => b.textContent === 'Lift the ban')!.click()
    await settle()
    expect(bans).toEqual([{ banned: true }, { banned: false }])
    expect(plain(app.host.textContent)).toContain('dana can sign in again.')
  })

  it('locks and unlocks a channel from the list', async () => {
    const locks: unknown[] = []
    app = await mountApp(
      routes(ADMIN, {
        'POST /api/v1/admin/channels/7/lock': ({ body }) => {
          locks.push(body)
          return { body: { id: 7, name: 'general', locked: (body as { locked: boolean }).locked } }
        },
      }),
      '/admin',
    )
    tab(app.host, 'Moderation').click()
    await settle()
    const row = () => [...app!.host.querySelectorAll('.admin-list__row')].find((r) => r.textContent?.includes('#general'))!
    expect(plain(row().textContent)).toContain('open')
    row().querySelector<HTMLButtonElement>('button')!.click()
    await settle()
    expect(locks).toEqual([{ locked: true }])
    expect(plain(row().textContent)).toContain('locked')
    expect(row().querySelector('button')?.textContent).toBe('Unlock')
  })

  it('shows errors translated, never as codes', async () => {
    app = await mountApp(
      routes(ADMIN, {
        'GET /api/v1/admin/status': () => ({ status: 500, body: { message: 'Server Error' } }),
        'GET /api/v1/users': () => ({ body: [DANA] }),
        'POST /api/v1/admin/users/2/ban': () => ({ status: 422, body: { error: 'cannot_ban_admin' } }),
      }),
      '/admin',
    )
    // The device's own choice wins over the account's (mountApp sets English): switch here.
    setLocale('fr')
    await settle()
    expect(plain(app.host.querySelector('.admin__error')?.textContent)).toContain('Le serveur a échoué. Réessayez dans un instant.')
    expect(app.host.textContent).not.toContain('server_error')

    tab(app.host, 'Modération').click()
    await settle()
    const input = app.host.querySelector<HTMLInputElement>('.admin__ban .people-picker__input')!
    typeInto(input, 'da')
    await wait(SEARCH_DELAY_MS + 20)
    await settle()
    key(input, { key: 'Enter' })
    await settle()
    ;[...app.host.querySelectorAll<HTMLButtonElement>('.admin__ban button')].find((b) => b.textContent === 'Bannir')!.click()
    await settle()
    ;[...document.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find((b) => b.textContent === 'Bannir')!.click()
    await settle()
    expect(plain(app.host.querySelector('.admin__section .admin__error')?.textContent)).toBe('Un administrateur ne peut pas être banni.')
    expect(app.host.textContent).not.toContain('cannot_ban_admin')
  })

  it('an administrator deletes a message, or one of its files, as a moderator from the message menu', async () => {
    const deletes: string[] = []
    app = await mountApp(
      routes(ADMIN, {
        'DELETE /api/v1/admin/files/40': ({ path }) => {
          deletes.push(path)
          return { status: 204 }
        },
        'DELETE /api/v1/admin/messages/2': ({ path }) => {
          deletes.push(path)
          return { body: { id: 2, channel_id: 7, parent_id: null, created_at: theirs.created_at, reply_count: 0, last_reply_at: null, deleted: true } }
        },
      }),
      '/c/7',
    )
    const items = await openMessageMenu(app.host)
    expect(items).toContain('Delete as moderator')
    expect(items).toContain('Delete junk.pdf as moderator')

    ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((m) => plain(m.textContent) === 'Delete junk.pdf as moderator')!.click()
    await settle()
    let dialog = document.querySelector('dialog[open]')!
    expect(plain(dialog.querySelector('.dialog__title')?.textContent)).toBe('Delete this file as a moderator?')
    expect(deletes).toEqual([])
    ;[...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Delete')!.click()
    await settle()
    expect(deletes).toEqual(['/api/v1/admin/files/40'])
    expect(app.host.querySelector('.message-list .file-chip, .message-list .attachment')).toBeNull()

    await openMessageMenu(app.host)
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((m) => plain(m.textContent) === 'Delete as moderator')!.click()
    await settle()
    dialog = document.querySelector('dialog[open]')!
    expect(plain(dialog.querySelector('.dialog__description')?.textContent)).toContain('This message by dana')
    ;[...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Delete')!.click()
    await settle()
    expect(deletes).toEqual(['/api/v1/admin/files/40', '/api/v1/admin/messages/2'])
    expect(app.host.querySelector('.message-list .tombstone')?.textContent).toContain('This message was deleted.')
  })

  it('a locked channel is read-only for its members: a notice instead of the composer', async () => {
    app = await mountApp(
      {
        'GET /api/v1/channels': () => ({ body: [channel(8, { name: 'random', locked: true })] }),
        'GET /api/v1/channels/8/messages': () => ({ body: { data: [live(2, { channel_id: 8 })], has_more: false } }),
      },
      '/c/8',
    )
    expect(app.host.querySelector('.composer')).toBeNull()
    expect(plain(app.host.querySelector('.join-bar--locked')?.textContent)).toBe('#random is locked by an administrator: you can read it, not post.')
    // No reacting or replying either.
    expect(app.host.querySelector('.message-list .message-actions__quick')).toBeNull()
  })
})
