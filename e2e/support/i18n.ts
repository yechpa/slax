/**
 * The app's own dictionaries (frontend/src/i18n), so assertions use exactly the strings each
 * language shows. Mirrors frontend/src/i18n/index.ts: inserted values are wrapped in Unicode
 * isolates (FSI…PDI), numbers formatted for the language, plurals picked by CLDR rules.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Locale = 'en' | 'he' | 'fr'
export type Theme = 'console' | 'listing'
export const LOCALES: readonly Locale[] = ['en', 'he', 'fr']
export const THEMES: readonly Theme[] = ['console', 'listing']

type Entry = string | Partial<Record<Intl.LDMLPluralRule, string>>
type Params = Record<string, string | number>

const dictionaries = Object.fromEntries(
  LOCALES.map((locale) => [locale, JSON.parse(readFileSync(join(__dirname, '../../frontend/src/i18n', `${locale}.json`), 'utf8')) as Record<string, Entry>]),
) as Record<Locale, Record<string, Entry>>

export const FSI = '⁨'
export const PDI = '⁩'

export function t(locale: Locale, key: string, params?: Params): string {
  const entry = dictionaries[locale][key] ?? dictionaries.en[key]
  if (entry === undefined) throw new Error(`No string ${key}`)
  let template: string
  if (typeof entry === 'string') template = entry
  else {
    const count = typeof params?.count === 'number' ? params.count : NaN
    const category = Number.isFinite(count) ? new Intl.PluralRules(locale).select(count) : 'other'
    template = entry[category] ?? entry.other ?? ''
  }
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name]
    if (value === undefined) return placeholder
    return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : FSI + value + PDI
  })
}

export const plural = (locale: Locale, key: string, count: number, params?: Params) => t(locale, key, { ...params, count })

export const dirOf = (locale: Locale) => (locale === 'he' ? 'rtl' : 'ltr')
