import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../i18n/index.ts'
import { KitchenSink } from './KitchenSink.tsx'
import { ShellDemo } from './ShellDemo.tsx'

let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  render(null, host)
  host.remove()
  setLocale('en')
})

describe('kitchen sink', () => {
  it('isolates every channel name and mention with its sigil (no "general#" in Hebrew)', () => {
    setLocale('he')
    render(<KitchenSink />, host)
    for (const el of host.querySelectorAll('.channel-header__name, .mention')) {
      const bdi = el.matches('bdi') ? el : el.querySelector('bdi')
      expect(bdi, el.outerHTML).not.toBeNull()
      expect(bdi!.textContent, el.outerHTML).toMatch(/^[#@]\S/)
    }
    expect(host.querySelectorAll('.mention').length).toBeGreaterThan(0)
  })

  it('names the focusable message list (role=log) in every language', () => {
    for (const locale of ['en', 'he', 'fr'] as const) {
      setLocale(locale)
      render(<ShellDemo />, host)
      const list = host.querySelector('.message-list')!
      expect(list.getAttribute('tabindex')).toBe('0')
      expect(list.getAttribute('role')).toBe('log')
      expect(list.getAttribute('aria-label') ?? '', locale).toMatch(/#general/)
      render(null, host)
    }
  })

  it('tags mixed-language demo content with lang', () => {
    render(<KitchenSink />, host)
    const hebrewBodies = [...host.querySelectorAll('.message__body')].filter((b) => /[֐-׿]/.test(b.textContent ?? ''))
    expect(hebrewBodies.length).toBeGreaterThan(0)
    for (const body of hebrewBodies) {
      const hebrewFirst = /^[^A-Za-z]*[֐-׿]/.test(body.textContent ?? '')
      if (hebrewFirst) expect(body.getAttribute('lang'), body.textContent ?? '').toBe('he')
    }
    for (const author of host.querySelectorAll('.message__author')) {
      if (/[֐-׿]/.test(author.textContent ?? '')) expect(author.getAttribute('lang')).toBe('he')
    }
  })
})
