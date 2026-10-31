import { useEffect, useState } from 'preact/hooks'
import { getLocale, onLocaleChange, type Locale } from './index.ts'

/** Re-renders the calling component whenever the locale changes. */
export function useLocale(): Locale {
  const [locale, setLocaleState] = useState(getLocale)
  useEffect(() => {
    setLocaleState(getLocale())
    return onLocaleChange(setLocaleState)
  }, [])
  return locale
}
