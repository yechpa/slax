/**
 * Slax i18n: three flat JSON dictionaries (en, he, fr), no framework.
 *
 * - `t(key, params)` returns plain text. Values are inserted verbatim (never
 *   parsed as HTML) and wrapped in Unicode isolates (FSI…PDI, the plain-text
 *   equivalent of <bdi>) so a Latin username inside a Hebrew sentence, or the
 *   reverse, cannot reorder the words around it.
 * - Plural entries are objects keyed by CLDR category (`one`, `two`, `other`…);
 *   `plural(key, n)` picks the form with Intl.PluralRules and fills `{count}`.
 * - A key missing in the current language falls back to English, then to the
 *   key itself, so a gap is visible but never blank.
 */
import { readPref, writePref } from '../lib/prefs.ts'
import en from './en.json'
import fr from './fr.json'
import he from './he.json'

export type Locale = 'en' | 'he' | 'fr'
export type Params = Record<string, string | number>
type Entry = string | Partial<Record<Intl.LDMLPluralRule, string>>
type Dictionary = Record<string, Entry>

export const LOCALES: readonly Locale[] = ['en', 'he', 'fr']
const RTL: ReadonlySet<Locale> = new Set(['he'])
const STORAGE_KEY = 'slax.locale'
const FALLBACK: Locale = 'en'

const dictionaries: Record<Locale, Dictionary> = { en, he, fr }
const listeners = new Set<(locale: Locale) => void>()
let current: Locale = FALLBACK

const FSI = '⁨'
const PDI = '⁩'

export const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale)
export const dirOf = (locale: Locale): 'rtl' | 'ltr' => (RTL.has(locale) ? 'rtl' : 'ltr')
export const getLocale = (): Locale => current

export function setLocale(locale: Locale): void {
  apply(locale)
  writePref(STORAGE_KEY, locale)
}

/** Subscribe to locale changes; returns the unsubscribe function. */
export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** First supported language in the browser's list ('iw' is the legacy code for Hebrew). */
export function detectLocale(languages: readonly string[] = globalThis.navigator?.languages ?? []): Locale {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split(/[-_]/)[0]
    const locale = primary === 'iw' ? 'he' : primary
    if (isLocale(locale)) return locale
  }
  return FALLBACK
}

/** Applies the stored choice, or the browser's languages, without persisting the latter. */
export function initLocale(): Locale {
  const stored = readPref(STORAGE_KEY)
  apply(isLocale(stored) ? stored : detectLocale())
  return current
}

export function t(key: string, params?: Params): string {
  const entry = lookup(key)
  if (entry === undefined) return key
  const template =
    typeof entry === 'string' ? entry : pickPlural(entry, typeof params?.count === 'number' ? params.count : NaN)
  return interpolate(template, params)
}

export function plural(key: string, count: number, params?: Params): string {
  return t(key, { ...params, count })
}

function apply(locale: Locale): void {
  if (!isLocale(locale)) return
  const changed = locale !== current
  current = locale
  const root = globalThis.document?.documentElement
  if (root) {
    root.lang = locale
    root.dir = dirOf(locale)
  }
  if (changed) listeners.forEach((listener) => listener(locale))
}

function lookup(key: string): Entry | undefined {
  return dictionaries[current][key] ?? dictionaries[FALLBACK][key]
}

function pickPlural(forms: Exclude<Entry, string>, count: number): string {
  const category = Number.isFinite(count) ? new Intl.PluralRules(current).select(count) : 'other'
  return forms[category] ?? forms.other ?? Object.values(forms)[0] ?? ''
}

/** One pass over the template: placeholders inside inserted values are never expanded. */
function interpolate(template: string, params?: Params): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (!(name in params)) return placeholder
    const value = params[name]
    return typeof value === 'number' ? new Intl.NumberFormat(current).format(value) : FSI + value + PDI
  })
}
