import { LOCALES, setLocale, t } from '../../i18n/index.ts'
import { useLocale } from '../../i18n/useLocale.ts'
import { Segmented } from './Segmented.tsx'

/** Each language is named in itself (English, עברית, Français) and tagged with its lang. */
export function LocaleSwitcher() {
  const locale = useLocale()
  const options = LOCALES.map((l) => ({ value: l, label: t(`locale.${l}`), lang: l }))
  return <Segmented legend={t('settings.language')} value={locale} options={options} onChange={setLocale} />
}
