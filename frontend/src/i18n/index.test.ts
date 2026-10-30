import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, render } from 'preact'
import en from './en.json'
import fr from './fr.json'
import he from './he.json'
import {
  LOCALES,
  detectLocale,
  getLocale,
  initLocale,
  onLocaleChange,
  plural,
  setLocale,
  t,
} from './index.ts'
import { withBrokenStorage } from '../test/storage.ts'

const FSI = '⁨'
const PDI = '⁩'
const html = () => document.documentElement

beforeEach(() => {
  localStorage.clear()
  setLocale('en')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('setLocale', () => {
  it('setLocale(he) sets dir=rtl', () => {
    setLocale('he')
    expect(html().getAttribute('dir')).toBe('rtl')
    expect(html().getAttribute('lang')).toBe('he')
    expect(getLocale()).toBe('he')
  })

  it('setLocale(fr) sets dir=ltr lang=fr', () => {
    setLocale('he')
    setLocale('fr')
    expect(html().getAttribute('dir')).toBe('ltr')
    expect(html().getAttribute('lang')).toBe('fr')
  })

  it('persists the choice and notifies listeners', () => {
    const seen: string[] = []
    const off = onLocaleChange((l) => seen.push(l))
    setLocale('fr')
    off()
    setLocale('he')
    expect(seen).toEqual(['fr'])
    expect(localStorage.getItem('slax.locale')).toBe('he')
  })

  it('still switches when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    expect(() => setLocale('he')).not.toThrow()
    expect(html().dir).toBe('rtl')
  })
})

describe('t', () => {
  it('translates in the current locale', () => {
    setLocale('fr')
    expect(t('action.send')).toBe('Envoyer')
    setLocale('he')
    expect(t('action.send')).toBe('שליחה')
  })

  it('t falls back to en for a missing key', () => {
    setLocale('fr')
    // A key only the English dictionary knows about, injected for the test.
    ;(en as Record<string, unknown>)['test.onlyInEnglish'] = 'English only'
    try {
      expect(t('test.onlyInEnglish')).toBe('English only')
    } finally {
      delete (en as Record<string, unknown>)['test.onlyInEnglish']
    }
  })

  it('returns the key itself when no dictionary has it', () => {
    expect(t('no.such.key')).toBe('no.such.key')
  })

  it('interpolates {name} and isolates the value for bidi', () => {
    expect(t('typing.one', { name: 'dana' })).toBe(`${FSI}dana${PDI} is typing…`)
    setLocale('he')
    expect(t('typing.one', { name: 'dana' })).toBe(`${FSI}dana${PDI} מקליד/ה…`)
  })

  it('returns plain text: interpolated values are never parsed as HTML', () => {
    const evil = '<img src=x onerror="alert(1)">'
    const text = t('typing.one', { name: evil })
    expect(text).toContain(evil)
    const host = document.createElement('div')
    render(h('p', null, text), host)
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain(evil)
  })

  it('does not re-expand placeholders found inside values', () => {
    expect(t('typing.two', { first: '{second}', second: 'noam' })).toBe(
      `${FSI}{second}${PDI} and ${FSI}noam${PDI} are typing…`,
    )
  })

  it('leaves unknown placeholders visible instead of dropping them', () => {
    expect(t('typing.one')).toBe('{name} is typing…')
  })
})

describe('plural', () => {
  it('uses one/other in English', () => {
    expect(plural('message.replies', 1)).toBe('1 reply')
    expect(plural('message.replies', 0)).toBe('0 replies')
    expect(plural('message.replies', 12)).toBe('12 replies')
  })

  it('treats 0 as singular in French', () => {
    setLocale('fr')
    expect(plural('message.replies', 0)).toBe('0 réponse')
    expect(plural('message.replies', 1)).toBe('1 réponse')
    expect(plural('message.replies', 2)).toBe('2 réponses')
    // CLDR "many" (1 000 000) is not in the file and falls back to "other".
    expect(plural('message.replies', 1_000_000)).toBe(
      `${new Intl.NumberFormat('fr').format(1_000_000)} réponses`,
    )
  })

  it('has a dual form in Hebrew', () => {
    setLocale('he')
    expect(plural('message.replies', 1)).toBe('תשובה אחת')
    expect(plural('message.replies', 2)).toBe('שתי תשובות')
    expect(plural('message.replies', 3)).toBe('3 תשובות')
    expect(plural('message.replies', 20)).toBe('20 תשובות')
  })

  it('formats {count} with the locale number format and keeps other params', () => {
    expect(plural('channel.members', 1200)).toBe('1,200 members')
    expect(plural('reaction.label', 2, { emoji: '🚀' })).toBe(`2 people reacted with ${FSI}🚀${PDI}`)
  })
})

describe('dictionaries', () => {
  type Dict = Record<string, string | Record<string, string>>
  const dicts: Record<string, Dict> = { en, fr, he }

  it('all three JSON files have identical key sets', () => {
    const keys = (d: Dict) => Object.keys(d).sort()
    expect(keys(fr)).toEqual(keys(en))
    expect(keys(he)).toEqual(keys(en))
  })

  it('plural entries carry the categories each language needs', () => {
    const needs: Record<string, string[]> = { en: ['one', 'other'], fr: ['one', 'other'], he: ['one', 'two', 'other'] }
    for (const [locale, dict] of Object.entries(dicts)) {
      for (const [key, value] of Object.entries(dict)) {
        const isPlural = typeof value === 'object'
        expect(isPlural, `${locale}:${key} plural shape`).toBe(typeof (en as Dict)[key] === 'object')
        if (isPlural) {
          expect(Object.keys(value).sort(), `${locale}:${key}`).toEqual([...needs[locale]].sort())
        }
      }
    }
  })

  it('uses the same placeholders in every language', () => {
    const placeholders = (v: string | Record<string, string>) =>
      [...new Set((typeof v === 'string' ? v : Object.values(v).join(' ')).match(/\{\w+\}/g) ?? [])].sort()
    for (const key of Object.keys(en)) {
      const expected = placeholders((en as Dict)[key]).filter((p) => p !== '{count}')
      for (const locale of ['fr', 'he']) {
        const got = placeholders(dicts[locale][key]).filter((p) => p !== '{count}')
        expect(got, `${locale}:${key}`).toEqual(expected)
      }
    }
  })

  it('has no empty strings', () => {
    for (const [locale, dict] of Object.entries(dicts)) {
      for (const [key, value] of Object.entries(dict)) {
        for (const s of typeof value === 'string' ? [value] : Object.values(value)) {
          expect(s.trim(), `${locale}:${key}`).not.toBe('')
        }
      }
    }
  })
})

describe('initial locale', () => {
  it('picks the first supported language from navigator.languages', () => {
    expect(detectLocale(['de-DE', 'fr-CA', 'en'])).toBe('fr')
    expect(detectLocale(['he-IL'])).toBe('he')
    expect(detectLocale(['iw'])).toBe('he')
    expect(detectLocale(['ja', 'zh'])).toBe('en')
    expect(detectLocale([])).toBe('en')
  })

  it('prefers a stored choice over the browser languages', () => {
    localStorage.setItem('slax.locale', 'he')
    vi.stubGlobal('navigator', { languages: ['fr-FR'] })
    expect(initLocale()).toBe('he')
    expect(html().dir).toBe('rtl')
  })

  it('ignores a stored value that is not a supported locale', () => {
    localStorage.setItem('slax.locale', 'xx')
    vi.stubGlobal('navigator', { languages: ['fr-FR'] })
    expect(initLocale()).toBe('fr')
  })

  it('works when reading localStorage throws', () => {
    vi.stubGlobal('navigator', { languages: ['he'] })
    expect(withBrokenStorage(() => initLocale())).toBe('he')
    expect(withBrokenStorage(() => (setLocale('fr'), getLocale()))).toBe('fr')
  })

  it('exposes the supported locales', () => {
    expect([...LOCALES]).toEqual(['en', 'he', 'fr'])
  })
})
