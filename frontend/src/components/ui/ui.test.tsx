import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../../i18n/index.ts'
import { ChannelName } from './ChannelName.tsx'
import { Composer } from './Composer.tsx'
import { FileChip } from './FileChip.tsx'
import { LocaleSwitcher } from './LocaleSwitcher.tsx'
import { Mention } from './Mention.tsx'
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

  it('does not send a blank message on Enter (like the disabled Send button)', () => {
    const onSend = vi.fn()
    render(<Composer channel="#general" value={'  \n '} onInput={() => undefined} onSend={onSend} />, host)
    const textarea = host.querySelector('textarea')!
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(onSend).not.toHaveBeenCalled()
    expect(host.querySelector<HTMLButtonElement>('.btn--primary')!.disabled).toBe(true)
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

describe('Composer input methods and limits', () => {
  it('composer_ignores_enter_during_ime_composition', () => {
    const onSend = vi.fn()
    render(<Composer channel="#general" value="にほんご" onInput={() => undefined} onSend={onSend} />, host)
    const textarea = host.querySelector('textarea')!
    const enter = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
      textarea.dispatchEvent(event)
      return event
    }

    // The Enter that confirms a candidate: no send, and the IME keeps the key.
    expect(enter({ isComposing: true }).defaultPrevented).toBe(false)
    // Safari reports that Enter as keyCode 229 after compositionend.
    expect(enter({ keyCode: 229 }).defaultPrevented).toBe(false)
    // Between compositionstart and compositionend, whatever the event says.
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    enter({})
    expect(onSend).not.toHaveBeenCalled()
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))

    // Once the composition is over, Enter sends.
    expect(enter({}).defaultPrevented).toBe(true)
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('counts code points near the limit and refuses to send over it', () => {
    const onSend = vi.fn()
    const near = 'a'.repeat(3990)
    render(<Composer channel="#general" value={near} onInput={() => undefined} onSend={onSend} maxLength={4000} />, host)
    expect(host.querySelector('.composer__counter')?.textContent).toBe('10 characters left')

    // 4001 emoji are 4001 characters for the server (not 8002 UTF-16 units).
    render(<Composer channel="#general" value={'🚀'.repeat(4001)} onInput={() => undefined} onSend={onSend} maxLength={4000} />, host)
    expect(host.querySelector('.composer__counter')?.textContent).toBe('1 character too many')
    expect(host.querySelector<HTMLButtonElement>('.btn--primary')!.disabled).toBe(true)
    host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(onSend).not.toHaveBeenCalled()

    render(<Composer channel="#general" value="short" onInput={() => undefined} maxLength={4000} />, host)
    expect(host.querySelector('.composer__counter')).toBeNull()
  })
})

describe('ChannelName and Mention', () => {
  it('keep the sigil and the name together in one <bdi>', () => {
    render(
      <p>
        <ChannelName name="general" /> <ChannelName name="עיצוב" /> <Mention name="נעם" />
      </p>,
      host,
    )
    const [latin, hebrew] = host.querySelectorAll('bdi.channel-name')
    expect(latin.textContent).toBe('#general')
    expect(hebrew.textContent).toBe('#עיצוב')
    expect(host.querySelector('bdi.mention')?.textContent).toBe('@נעם')
  })

  it('accept a lang for screen readers', () => {
    render(<Mention name="נעם" lang="he" />, host)
    expect(host.querySelector('bdi.mention')?.getAttribute('lang')).toBe('he')
  })
})

describe('Message lang', () => {
  it('tags the body and the author with their languages', () => {
    render(
      <Message author="נעם" authorLang="he" hue={2} time={{ iso: 'x', label: '09:43' }} lang="he">
        שלום
      </Message>,
      host,
    )
    expect(host.querySelector('.message__body')?.getAttribute('lang')).toBe('he')
    expect(host.querySelector('.message__author')?.getAttribute('lang')).toBe('he')
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
