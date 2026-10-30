/**
 * Two themes: `console` (dark: phosphor green on near-black) and `listing`
 * (light: green-bar printer paper). The active one is the `data-theme`
 * attribute on <html>; tokens.css keys every colour off it.
 *
 * Until the user picks one, the theme follows `prefers-color-scheme` (and keeps
 * following it live). An explicit choice is persisted and wins from then on.
 */
import { readPref, writePref } from './lib/prefs.ts'

export type Theme = 'console' | 'listing'

export const THEMES: readonly Theme[] = ['console', 'listing']
const STORAGE_KEY = 'slax.theme'
const LIGHT_QUERY = '(prefers-color-scheme: light)'

const listeners = new Set<(theme: Theme) => void>()
let current: Theme = 'console'
let stopFollowingSystem: (() => void) | null = null

export const isTheme = (value: unknown): value is Theme => THEMES.includes(value as Theme)
export const getTheme = (): Theme => current

/** The theme matching the OS preference: light → listing, anything else → console. */
export function preferredTheme(): Theme {
  return globalThis.matchMedia?.(LIGHT_QUERY).matches ? 'listing' : 'console'
}

/** Explicit user choice: applied, persisted, and system changes are no longer followed. */
export function setTheme(theme: Theme): void {
  stopFollowingSystem?.()
  stopFollowingSystem = null
  apply(theme)
  writePref(STORAGE_KEY, theme)
}

export function onThemeChange(listener: (theme: Theme) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Applies the stored choice, or the system preference (followed live until a choice is made). */
export function initTheme(): Theme {
  stopFollowingSystem?.()
  stopFollowingSystem = null
  const stored = readPref(STORAGE_KEY)
  if (isTheme(stored)) {
    apply(stored)
    return current
  }
  apply(preferredTheme())
  const media = globalThis.matchMedia?.(LIGHT_QUERY)
  if (media?.addEventListener) {
    const follow = () => apply(preferredTheme())
    media.addEventListener('change', follow)
    stopFollowingSystem = () => media.removeEventListener('change', follow)
  }
  return current
}

function apply(theme: Theme): void {
  if (!isTheme(theme)) return
  const changed = theme !== current
  current = theme
  const root = globalThis.document?.documentElement
  if (root) root.dataset.theme = theme
  if (changed) listeners.forEach((listener) => listener(theme))
}
