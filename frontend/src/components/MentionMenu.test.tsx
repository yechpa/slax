import { afterEach, describe, expect, it } from 'vitest'
import { ME, channel, live } from '../test/fixtures.ts'
import { key, mountApp, plain, settle, type Mounted } from '../test/mountApp.tsx'
import type { Locale } from '../i18n/index.ts'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
})

const member = (id: number, name: string, role: 'owner' | 'member' = 'member') => ({ id, name, avatar_url: null, role })
const MEMBERS = [member(1, 'Alice', 'owner'), member(2, 'Dana Cohen'), member(3, 'Dana Levi'), member(4, 'Yossi Mizrahi')]

const routes = (members: unknown = MEMBERS) => ({
  'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' })] }),
  'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(1, { body: 'hello' })], has_more: false } }),
  'GET /api/v1/channels/7/members': () => ({ body: members }),
  'POST /api/v1/channels/7/messages': ({ body }: { body: unknown }) => {
    const sent = body as { body: string; client_id: string }
    return { status: 201, body: live(2, { body: sent.body, client_id: sent.client_id, user: { id: ME.id, name: ME.name, avatar_url: null } }) }
  },
})

const field = () => app!.host.querySelector<HTMLTextAreaElement>('.shell__footer textarea')!
const menu = () => app!.host.querySelector<HTMLElement>('.shell__footer .mention-menu')
const options = () => [...app!.host.querySelectorAll<HTMLElement>('.shell__footer [role="option"]')]
const optionNames = () => options().map((o) => plain(o.querySelector('.mention-menu__name')?.textContent))
const posts = () => app!.server.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/channels/7/messages')

/** Types `text` with the caret at its end (or at `caret`), as a person does. */
async function type(text: string, caret = text.length): Promise<void> {
  const input = field()
  input.value = text
  input.setSelectionRange(caret, caret)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

async function open(path = '/c/7', extra: Record<string, never> = {}, locale: Locale = 'en'): Promise<void> {
  app = await mountApp({ ...routes(), ...extra }, path, { locale })
}

describe('the @mention menu', () => {
  it('opens on @ with the other members, in a listbox the field points at', async () => {
    await open()
    expect(menu()).toBeNull()
    await type('@')
    expect(menu()?.getAttribute('role')).toBe('listbox')
    expect(menu()?.getAttribute('aria-label')).toBe('People you can mention')
    // Not me; DanaCohen and DanaLevi are told apart, Yossi is simply Yossi.
    expect(optionNames()).toEqual(['Dana Cohen', 'Dana Levi', 'Yossi Mizrahi'])
    expect(options().map((o) => plain(o.querySelector('.mention-menu__handle')?.textContent))).toEqual(['@DanaCohen', '@DanaLevi', '@Yossi'])
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[0].id)
    expect(field().getAttribute('aria-controls')).toBe(menu()!.id)
    expect(app!.host.querySelector('.shell__footer [role="status"]')?.textContent).toContain('3 people match')
  })

  it('asks for the members once for a whole mention, and keeps them', async () => {
    await open()
    await type('@')
    await type('@y')
    await type('@yo')
    await type('')
    await type('@')
    const asked = () => app!.server.calls.filter((c) => c.path === '/api/v1/channels/7/members')
    expect(asked()).toHaveLength(1)
  })

  it('filters as the user types, ignoring case', async () => {
    await open()
    await type('hello @DA')
    expect(optionNames()).toEqual(['Dana Cohen', 'Dana Levi'])
    await type('hello @danal')
    expect(optionNames()).toEqual(['Dana Levi'])
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[0].id)
    await type('hello @zz')
    expect(menu()).toBeNull()
    expect(field().getAttribute('aria-activedescendant')).toBeNull()
  })

  it('is not opened by an e-mail address or a finished mention', async () => {
    await open()
    await type('mail@')
    expect(menu()).toBeNull()
    await type('@dana ')
    expect(menu()).toBeNull()
  })

  it('moves with the arrows and picks with Enter: @handle and a space, nothing sent', async () => {
    await open()
    await type('hi @da')
    expect(key(field(), { key: 'ArrowDown' })).toBe(false)
    await settle()
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[1].id)
    expect(key(field(), { key: 'Enter' })).toBe(false)
    await settle()
    expect(field().value).toBe('hi @DanaLevi ')
    expect(field().selectionStart).toBe('hi @DanaLevi '.length)
    expect(menu()).toBeNull()
    expect(posts()).toHaveLength(0)
  })

  it('picks with Tab, and wraps round with ArrowUp', async () => {
    await open()
    await type('@')
    key(field(), { key: 'ArrowUp' })
    await settle()
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true'])
    expect(key(field(), { key: 'Tab' })).toBe(false)
    await settle()
    expect(field().value).toBe('@Yossi ')
  })

  it('picks by a tap, and keeps the focus in the field (mousedown is cancelled)', async () => {
    await open()
    await type('@yo')
    const [option] = options()
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    expect(option.dispatchEvent(down)).toBe(false)
    option.click()
    await settle()
    expect(field().value).toBe('@Yossi ')
    expect(menu()).toBeNull()
  })

  it('completes in the middle of the text, and the sentence goes on after it', async () => {
    await open()
    await type('hi @yo there', 6)
    expect(optionNames()).toEqual(['Yossi Mizrahi'])
    key(field(), { key: 'Enter' })
    await settle()
    expect(field().value).toBe('hi @Yossi there')
  })

  it('Escape closes it, and only it: the mention stays closed while it is typed on', async () => {
    await open()
    await type('@da')
    const escape = key(field(), { key: 'Escape' })
    await settle()
    expect(escape).toBe(false)
    expect(menu()).toBeNull()
    await type('@dan')
    expect(menu()).toBeNull()
    // A new mention opens it again.
    await type('@dan @y')
    expect(optionNames()).toEqual(['Yossi Mizrahi'])
  })

  it('does not swallow Enter when it is closed: the message is sent', async () => {
    await open()
    await type('hello @zz')
    key(field(), { key: 'Enter' })
    await settle()
    expect(posts().map((c) => (c.body as { body: string }).body)).toEqual(['hello @zz'])

    // Closed by Escape: Enter sends as well.
    await type('bye @da')
    key(field(), { key: 'Escape' })
    await settle()
    key(field(), { key: 'Enter' })
    await settle()
    expect(posts().map((c) => (c.body as { body: string }).body)).toEqual(['hello @zz', 'bye @da'])
  })

  it('sends the mention it wrote, whole', async () => {
    await open()
    await type('@danac')
    key(field(), { key: 'Enter' })
    await settle()
    key(field(), { key: 'Enter' })
    await settle()
    expect(posts().map((c) => (c.body as { body: string }).body)).toEqual(['@DanaCohen'])
  })

  it('Shift+Enter breaks the line, as ever, and is not a pick', async () => {
    await open()
    await type('@yo')
    key(field(), { key: 'Enter', shiftKey: true })
    await settle()
    expect(field().value).toBe('@yo')
  })

  it('is just the plain composer when the members cannot be had', async () => {
    await open('/c/7', { 'GET /api/v1/channels/7/members': () => ({ status: 500, body: { error: 'server_error' } }) } as never)
    await type('@da')
    expect(menu()).toBeNull()
    key(field(), { key: 'Enter' })
    await settle()
    expect(posts()).toHaveLength(1)
  })

  it('takes the participants of a conversation from the conversation, without asking', async () => {
    const dm = channel(9, {
      kind: 'group_dm',
      name: null,
      members: [
        { id: 1, name: 'Alice', avatar_url: null },
        { id: 2, name: 'Dana Cohen', avatar_url: null },
        { id: 5, name: 'Noa Bar', avatar_url: null },
      ],
    })
    app = await mountApp({ ...routes(), 'GET /api/v1/channels': () => ({ body: [dm] }), 'GET /api/v1/channels/9/messages': () => ({ body: { data: [], has_more: false } }) }, '/c/9')
    await type('@')
    expect(optionNames()).toEqual(['Dana Cohen', 'Noa Bar'])
    expect(options().map((o) => plain(o.querySelector('.mention-menu__handle')?.textContent))).toEqual(['@Dana', '@Noa'])
    expect(app.server.calls.some((c) => c.path.endsWith('/members'))).toBe(false)
  })

  it('works in Hebrew: Hebrew names, the menu and its announcement in Hebrew, handles left to right', async () => {
    await open('/c/7', { 'GET /api/v1/channels/7/members': () => ({ body: [member(1, 'Alice'), member(2, 'דנה כהן'), member(3, 'נעם לוי')] }) } as never, 'he')
    await type('@דנ')
    expect(optionNames()).toEqual(['דנה כהן'])
    expect(menu()?.getAttribute('aria-label')).toBe('אנשים שאפשר לתייג')
    expect(options()[0].querySelector('.mention-menu__handle')?.getAttribute('dir')).toBe('ltr')
    expect(app!.host.querySelector('.shell__footer [role="status"]')?.textContent).toBe('אדם אחד מתאים. חצים למעלה ולמטה לניווט, Enter לבחירה, Escape לסגירה.')
    key(field(), { key: 'Enter' })
    await settle()
    expect(field().value).toBe('@דנה ')
  })

  it('speaks French', async () => {
    await open('/c/7', {}, 'fr')
    await type('@y')
    expect(menu()?.getAttribute('aria-label')).toBe('Personnes à mentionner')
    expect(app!.host.querySelector('.shell__footer [role="status"]')?.textContent).toContain('1 personne correspond')
  })
})
