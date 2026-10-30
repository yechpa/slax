/**
 * Small user preferences (theme, locale) kept in localStorage.
 *
 * Storage can be missing or hostile: private windows, blocked site data
 * (the `localStorage` getter itself throws a SecurityError), full quota.
 * A preference that cannot be read is simply absent, and one that cannot be
 * written is kept for the current page only. Neither ever breaks the UI.
 */
export function readPref(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writePref(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Not persisted; the in-memory value still applies.
  }
}
