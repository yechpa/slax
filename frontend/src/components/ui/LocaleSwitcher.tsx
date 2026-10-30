import { LOCALES, setLocale, t, type Locale } from '../../i18n/index.ts'
import { useLocale } from '../../i18n/useLocale.ts'
import { Segmented } from './Segmented.tsx'

/**
 * Each language is named in itself (English, עברית, Français) and tagged with its lang.
 * `onChange` runs after the language is applied (e.g. to save it to the account).
 */
export function LocaleSwitcher({ onChange }: { onChange?: (locale: Locale) => void }) {
  const locale = useLocale()
  const options = LOCALES.map((l) => ({ value: l, label: t(`locale.${l}`), lang: l }))
  const choose = (next: Locale) => {
    setLocale(next)
    onChange?.(next)
  }
  return <Segmented legend={t('settings.language')} value={locale} options={options} onChange={choose} />
}
