import { useEffect, useState } from 'preact/hooks'
import { getTheme, onThemeChange, type Theme } from './theme.ts'

/** Re-renders the calling component whenever the theme changes. */
export function useTheme(): Theme {
  const [theme, setThemeState] = useState(getTheme)
  useEffect(() => {
    setThemeState(getTheme())
    return onThemeChange(setThemeState)
  }, [])
  return theme
}
