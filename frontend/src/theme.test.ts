import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEMES, THEME_COLORS, getTheme, initTheme, onThemeChange, preferredTheme, setTheme } from './theme.ts'
import { withBrokenStorage } from './test/storage.ts'

const html = () => document.documentElement

/** A controllable `prefers-color-scheme` media query. */
function fakeColorScheme(initial: 'light' | 'dark') {
  let scheme = initial
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return query.includes('light') ? scheme === 'light' : scheme === 'dark'
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }))
  return {
    change(next: 'light' | 'dark') {
      scheme = next
      listeners.forEach((fn) => fn())
    },
  }
}

beforeEach(() => {
  setTheme('console')
  localStorage.clear()
  html().removeAttribute('data-theme')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('setTheme', () => {
  it('sets data-theme on <html> and persists the choice', () => {
    setTheme('listing')
    expect(html().dataset.theme).toBe('listing')
    expect(getTheme()).toBe('listing')
    expect(localStorage.getItem('slax.theme')).toBe('listing')
  })

  it('notifies listeners until they unsubscribe', () => {
    const seen: string[] = []
    const off = onThemeChange((t) => seen.push(t))
    setTheme('listing')
    off()
    setTheme('console')
    expect(seen).toEqual(['listing'])
  })

  it('still applies the theme when localStorage throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    expect(() => setTheme('listing')).not.toThrow()
    expect(html().dataset.theme).toBe('listing')
  })

  it('still applies the theme when localStorage itself is inaccessible', () => {
    fakeColorScheme('dark')
    withBrokenStorage(() => {
      expect(() => setTheme('listing')).not.toThrow()
      expect(html().dataset.theme).toBe('listing')
      // Nothing could be stored, so a fresh start falls back to the system preference.
      expect(initTheme()).toBe('console')
    })
    expect(html().dataset.theme).toBe('console')
  })

  it('knows its two themes', () => {
    expect([...THEMES]).toEqual(['console', 'listing'])
  })
})

describe('default theme', () => {
  it('follows prefers-color-scheme: dark -> console', () => {
    fakeColorScheme('dark')
    expect(preferredTheme()).toBe('console')
    expect(initTheme()).toBe('console')
    expect(html().dataset.theme).toBe('console')
  })

  it('follows prefers-color-scheme: light -> listing', () => {
    fakeColorScheme('light')
    expect(initTheme()).toBe('listing')
    expect(html().dataset.theme).toBe('listing')
  })

  it('falls back to console when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(preferredTheme()).toBe('console')
  })

  it('tracks system changes until the user chooses, without persisting', () => {
    const media = fakeColorScheme('dark')
    initTheme()
    media.change('light')
    expect(html().dataset.theme).toBe('listing')
    expect(localStorage.getItem('slax.theme')).toBeNull()

    setTheme('console')
    media.change('light')
    expect(html().dataset.theme).toBe('console')
  })

  it('a stored choice wins over the system preference', () => {
    fakeColorScheme('dark')
    localStorage.setItem('slax.theme', 'listing')
    expect(initTheme()).toBe('listing')
  })

  it('ignores an unknown stored value', () => {
    fakeColorScheme('light')
    localStorage.setItem('slax.theme', 'solarized')
    expect(initTheme()).toBe('listing')
  })
})

describe('theme-color', () => {
  function metas() {
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove())
    for (const scheme of ['dark', 'light']) {
      const meta = document.createElement('meta')
      meta.name = 'theme-color'
      meta.media = `(prefers-color-scheme: ${scheme})`
      document.head.append(meta)
    }
    return () => [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((meta) => meta.content)
  }

  it("follows the active theme, whatever the system's colour scheme (the browser chrome matches the page)", () => {
    const contents = metas()
    setTheme('listing')
    expect(contents()).toEqual([THEME_COLORS.listing, THEME_COLORS.listing])
    setTheme('console')
    expect(contents()).toEqual([THEME_COLORS.console, THEME_COLORS.console])
  })

  it('follows the system while no theme was chosen', () => {
    const contents = metas()
    const scheme = fakeColorScheme('light')
    initTheme()
    expect(contents()).toEqual([THEME_COLORS.listing, THEME_COLORS.listing])
    scheme.change('dark')
    expect(contents()).toEqual([THEME_COLORS.console, THEME_COLORS.console])
  })
})
