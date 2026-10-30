import { t } from '../../i18n/index.ts'
import { THEMES, setTheme } from '../../theme.ts'
import { useTheme } from '../../useTheme.ts'
import { Segmented } from './Segmented.tsx'

export function ThemeSwitcher() {
  const theme = useTheme()
  const options = THEMES.map((th) => ({ value: th, label: t(`theme.${th}`), title: t(`theme.${th}.hint`) }))
  return <Segmented legend={t('settings.theme')} value={theme} options={options} onChange={setTheme} />
}
