import { getLocale } from './index.ts'

/** 24-hour clock in every language: terminals do not say "AM". */
export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const

/** 1234567 → "1.2 MB" (localised number and unit). */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  return new Intl.NumberFormat(getLocale(), {
    style: 'unit',
    unit: UNITS[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1,
  }).format(value)
}
