import { afterEach, describe, expect, it } from 'vitest'
import { ME, channel, live } from '../test/fixtures.ts'
import type { FakeHandler } from '../test/fakes.ts'
import { key, mountApp, plain, settle, typeInto, type Mounted } from '../test/mountApp.tsx'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
})

const ME_USER = { id: ME.id, name: ME.name, avatar_url: null }
const mine = live(1, { body: 'my words', user: ME_USER })
const theirs = live(2, { body: 'their words' })

function setup(extra: Record<string, FakeHandler> = {}) {
  return mountApp(
    {
      'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' })] }),
      'GET /api/v1/channels/7/messages': () => ({ body: { data: [mine, theirs], has_more: false } }),
      ...extra,
    },
    '/c/7',
  )
}

const item = (host: HTMLElement, index: number) => host.querySelectorAll<HTMLElement>('.message-list .message-item')[index]

async function openMenu(host: HTMLElement, index: number): Promise<string[]> {
  item(host, index).querySelector<HTMLButtonElement>('.message-actions__more')!.click()
  await settle()
  return [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((m) => m.textContent ?? '')
}

async function chooseFromMenu(host: HTMLElement, index: number, label: string): Promise<void> {
  await openMenu(host, index)
  ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((m) => m.textContent === label)!.click()
  await settle()
}

describe('message actions', () => {
  it('offers edit and delete on my messages only, from a menu reachable without hover', async () => {
    app = await setup()
    expect(await openMenu(app.host, 0)).toEqual(['Reply in thread', 'Add reaction', 'Edit', 'Delete'])
    // The menu takes focus; Escape gives it back to its button.
    expect(document.activeElement?.textContent).toBe('Reply in thread')
    key(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Add reaction')
    key(document.activeElement!, { key: 'Escape' })
    await settle()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(item(app.host, 0).querySelector('.message-actions__more'))

    expect(await openMenu(app.host, 1)).toEqual(['Reply in thread', 'Add reaction'])
  })

  it('edit_message_inline_is_ime_safe', async () => {
    const patches: unknown[] = []
    app = await setup({
      'PATCH /api/v1/messages/1': ({ body }) => {
        patches.push(body)
        return { body: { ...mine, body: (body as { body: string }).body, edited_at: '2026-10-30T10:00:00.000Z' } }
      },
    })
    await chooseFromMenu(app.host, 0, 'Edit')
    const field = item(app.host, 0).querySelector<HTMLTextAreaElement>('.message-editor__input')!
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('my words')

    // Composing (Japanese input): Enter confirms the composition, it does not save.
    typeInto(field, '  my words, 日本')
    await settle()
    field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    key(field, { key: 'Enter', isComposing: true })
    key(field, { key: 'Enter' })
    field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    key(field, { key: 'Enter', keyCode: 229 })
    await settle()
    expect(patches).toEqual([])
    // Shift+Enter is a new line, not a save.
    key(field, { key: 'Enter', shiftKey: true })
    expect(patches).toEqual([])

    // Enter, composition over: saved, trimmed as the server will.
    key(field, { key: 'Enter' })
    await settle()
    expect(patches).toEqual([{ body: 'my words, 日本' }])
    expect(item(app.host, 0).querySelector('.message-editor')).toBeNull()
    expect(item(app.host, 0).querySelector('.message__body')?.textContent).toBe('my words, 日本')
    expect(item(app.host, 0).querySelector('.message__edited')?.textContent).toBe('(edited)')

    // Escape cancels, nothing sent; an empty text cannot be saved.
    await chooseFromMenu(app.host, 0, 'Edit')
    const again = item(app.host, 0).querySelector<HTMLTextAreaElement>('.message-editor__input')!
    typeInto(again, '   ')
    await settle()
    expect(item(app.host, 0).querySelector<HTMLButtonElement>('.message-editor .btn--primary')!.disabled).toBe(true)
    expect(plain(item(app.host, 0).querySelector('.message-editor__hint')?.textContent)).toBe('A message needs some text to be edited.')
    key(again, { key: 'Enter' })
    key(again, { key: 'Escape' })
    await settle()
    expect(patches).toHaveLength(1)
    expect(item(app.host, 0).querySelector('.message-editor')).toBeNull()
  })

  it('says why an edit was refused, and keeps the editor open', async () => {
    app = await setup({ 'PATCH /api/v1/messages/1': () => ({ status: 422, body: { message: 'The body field is required.', errors: { body: ['required'] } } }) })
    await chooseFromMenu(app.host, 0, 'Edit')
    const field = item(app.host, 0).querySelector<HTMLTextAreaElement>('.message-editor__input')!
    typeInto(field, 'changed')
    await settle()
    key(field, { key: 'Enter' })
    await settle()
    expect(plain(app.host.querySelector('.toast--error')?.textContent)).toContain('A message needs some text to be edited.')
    expect(item(app.host, 0).querySelector('.message-editor')).not.toBeNull()
  })

  it('deletes after a confirmation, leaving a tombstone', async () => {
    app = await setup({ 'DELETE /api/v1/messages/1': () => ({ body: { id: 1, channel_id: 7, parent_id: null, created_at: mine.created_at, reply_count: 0, last_reply_at: null, deleted: true } }) })
    await chooseFromMenu(app.host, 0, 'Delete')
    const dialog = document.querySelector('dialog')!
    expect(dialog.getAttribute('role')).toBe('alertdialog')
    expect(plain(dialog.querySelector('.dialog__title')?.textContent)).toBe('Delete this message?')
    // Cancel is the safe default.
    expect(document.activeElement?.textContent).toBe('Cancel')
    ;[...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Delete')!.click()
    await settle()
    expect(document.querySelector('dialog')).toBeNull()
    expect(app.host.querySelector('.message-list .tombstone')?.textContent).toContain('This message was deleted.')
    expect([...app.host.querySelectorAll('.message-list .message__body')].map((b) => b.textContent)).toEqual(['their words'])
  })

  it('reacts from the picker, with arrow keys', async () => {
    const puts: string[] = []
    app = await setup({
      [`PUT /api/v1/messages/2/reactions/${encodeURIComponent('👎')}`]: ({ path }) => {
        puts.push(decodeURIComponent(path.split('/').pop()!))
        return { body: { ...theirs, reactions: [{ emoji: '👎', count: 1, reacted_by_me: true, user_ids: [ME.id] }] } }
      },
    })
    item(app.host, 1).querySelector<HTMLButtonElement>('.message-actions__quick')!.click()
    await settle()
    const picker = document.querySelector<HTMLElement>('.emoji-picker')!
    expect(document.activeElement?.textContent).toBe('👍')
    key(document.activeElement!, { key: 'ArrowRight' })
    await settle()
    expect(document.activeElement?.textContent).toBe('👎')
    ;(document.activeElement as HTMLButtonElement).click()
    await settle()
    expect(puts).toEqual(['👎'])
    expect(picker.isConnected).toBe(false)
    const chip = item(app.host, 1).querySelector('.reaction[aria-pressed="true"]')!
    expect(plain(chip.getAttribute('aria-label'))).toBe('1 person reacted with 👎')
  })
})
