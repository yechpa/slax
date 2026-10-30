import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../../i18n/index.ts'
import { Composer } from './Composer.tsx'
import { FileChip } from './FileChip.tsx'
import { LocaleSwitcher } from './LocaleSwitcher.tsx'
import { Message } from './Message.tsx'
import { NavItem } from './NavItem.tsx'
import { PresenceDot } from './PresenceDot.tsx'
import { typingText } from './TypingIndicator.tsx'

const strip = (s: string | null | undefined) => (s ?? '').replace(/[⁨⁩]/g, '')
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

describe('Message', () => {
  it('isolates the author in <bdi> and lets the body pick its own direction', () => {
    render(
      <Message author="נעם" hue={2} time={{ iso: '2026-10-30T09:43:00Z', label: '09:43' }} edited>
        מעולה, see <a href="https://example.test">https://example.test</a>
      </Message>,
      host,
    )
    expect(host.querySelector('bdi.message__author')?.textContent).toBe('נעם')
    expect(host.querySelector('.message__body')?.getAttribute('dir')).toBe('auto')
    expect(host.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-30T09:43:00Z')
    expect(host.querySelector('.message__edited')?.textContent).toBe('(edited)')
  })
})

describe('NavItem', () => {
  it('marks the current channel and announces unread counts', () => {
    render(<NavItem name="general" href="#" selected unread={3} />, host)
    const link = host.querySelector('a')!
    expect(link.getAttribute('aria-current')).toBe('page')
    expect(host.querySelector('.nav-item__badge')?.getAttribute('aria-label')).toBe('3 unread messages')
  })

  it('shows no badge for a muted channel', () => {
    render(<NavItem name="random" href="#" muted unread={12} />, host)
    expect(host.querySelector('.nav-item__badge')).toBeNull()
    expect(host.textContent).toContain('muted')
  })
})

describe('PresenceDot', () => {
  it('has a translated accessible name', () => {
    setLocale('fr')
    render(<PresenceDot status="away" />, host)
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('absent')
  })
})

describe('typingText', () => {
  it('covers nobody, one, two and several people', () => {
    expect(typingText([])).toBe('')
    expect(strip(typingText(['dana']))).toBe('dana is typing…')
    expect(strip(typingText(['dana', 'noam']))).toBe('dana and noam are typing…')
    expect(typingText(['a', 'b', 'c'])).toBe('Several people are typing…')
  })
})

describe('Composer', () => {
  it('draws the placeholder with a cursor only while empty', () => {
    render(<Composer channel="#general" value="" onInput={() => undefined} />, host)
    expect(strip(host.querySelector('.composer__placeholder')?.textContent)).toBe('Message #general')
    expect(host.querySelector('.composer__placeholder .cursor')).not.toBeNull()
    expect(host.querySelector('textarea')?.hasAttribute('dir')).toBe(false)

    render(<Composer channel="#general" value="שלום" onInput={() => undefined} />, host)
    expect(host.querySelector('.composer__placeholder')).toBeNull()
    expect(host.querySelector('textarea')?.getAttribute('dir')).toBe('auto')
  })

  it('sends on Enter but not on Shift+Enter', () => {
    const onSend = vi.fn()
    render(<Composer channel="#general" value="hi" onInput={() => undefined} onSend={onSend} />, host)
    const textarea = host.querySelector('textarea')!
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    expect(onSend).not.toHaveBeenCalled()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onSend).toHaveBeenCalledOnce()
  })
})

describe('FileChip', () => {
  it('isolates the name and the size for bidi', () => {
    render(<FileChip name="סקיצה.png" bytes={387_000} />, host)
    expect(host.querySelector('bdi.file-chip__name')?.textContent).toBe('סקיצה.png')
    expect(host.querySelector('bdi.file-chip__size')?.textContent).toMatch(/387/)
  })
})

describe('LocaleSwitcher', () => {
  it('switches the document to Hebrew, right to left', async () => {
    render(<LocaleSwitcher />, host)
    const hebrew = host.querySelector<HTMLInputElement>('input[value="he"]')!
    expect(hebrew.closest('label')?.getAttribute('lang')).toBe('he')
    hebrew.click()
    expect(document.documentElement.dir).toBe('rtl')
    await new Promise((resolve) => setTimeout(resolve))
    expect(host.querySelector<HTMLInputElement>('input[value="he"]')!.checked).toBe(true)
  })
})
