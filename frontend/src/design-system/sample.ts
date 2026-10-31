/** Demo content for the kitchen sink. User content is never translated: a real team mixes languages. */
import { formatTime } from '../i18n/format.ts'
import type { Presence } from '../components/ui/PresenceDot.tsx'

const at = (hh: number, mm: number) => {
  const date = new Date(2026, 9, 30, hh, mm)
  return { iso: date.toISOString(), label: formatTime(date) }
}

export const time = at

/** `lang` only where the name is not Latin-script (the page language may be anything). */
export const people: Record<string, { name: string; hue: number; presence: Presence; lang?: string }> = {
  dana: { name: 'dana', hue: 1, presence: 'online' },
  noam: { name: 'נעם', hue: 2, presence: 'away', lang: 'he' },
  maya: { name: 'maya', hue: 3, presence: 'offline' },
  lea: { name: 'léa', hue: 4, presence: 'online' },
  yael: { name: 'יעל', hue: 5, presence: 'online', lang: 'he' },
  omer: { name: 'omer', hue: 6, presence: 'offline' },
}

export const channels = [
  { name: 'general', selected: true },
  { name: 'engineering', unread: 3 },
  { name: 'security' },
  { name: 'עיצוב', unread: 1, lang: 'he' },
  { name: 'random', muted: true, unread: 12 },
]

export const directMessages = [
  { key: 'dana', unread: 0 },
  { key: 'noam', unread: 0 },
  { key: 'lea', unread: 2 },
  { key: 'maya', unread: 0 },
] as const

export const GRAFANA_URL = 'https://grafana.slax.dev/d/k3s?from=now-1h'
