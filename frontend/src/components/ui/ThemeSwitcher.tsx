import { t } from '../../i18n/index.ts'
import { THEMES, setTheme, type Theme } from '../../theme.ts'
import { useTheme } from '../../useTheme.ts'
import { Segmented } from './Segmented.tsx'

/** `onChange` runs after the theme is applied (e.g. to save it to the account). */
export function ThemeSwitcher({ onChange }: { onChange?: (theme: Theme) => void }) {
  const theme = useTheme()
  const options = THEMES.map((th) => ({ value: th, label: t(`theme.${th}`), title: t(`theme.${th}.hint`) }))
  const choose = (next: Theme) => {
    setTheme(next)
    onChange?.(next)
  }
  return <Segmented legend={t('settings.theme')} value={theme} options={options} onChange={choose} />
}
