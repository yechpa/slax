import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrastRatio, relativeLuminance } from '../lib/contrast.ts'
import { THEMES, type Theme } from '../theme.ts'

const tokensCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8')

/** Reads the custom properties declared in the `[data-theme="…"]` block, resolving var() chains. */
function themeTokens(theme: Theme): Record<string, string> {
  const block = new RegExp(String.raw`\[data-theme=["']?${theme}["']?\]\s*\{([^}]*)\}`).exec(
    tokensCss.replace(/\/\*[\s\S]*?\*\//g, ''),
  )
  if (!block) throw new Error(`no [data-theme="${theme}"] block in tokens.css`)
  const raw: Record<string, string> = {}
  for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) raw[name] = value.trim()
  const resolve = (value: string, depth = 0): string => {
    const ref = /^var\((--[\w-]+)\)$/.exec(value)
    if (!ref) return value
    if (depth > 5 || !(ref[1] in raw)) throw new Error(`cannot resolve ${value}`)
    return resolve(raw[ref[1]], depth + 1)
  }
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)]))
}

const BACKGROUNDS = ['--color-bg', '--color-band-a', '--color-band-b', '--color-surface']

/** [foreground, backgrounds, minimum ratio]: text needs 4.5:1 (WCAG AA), UI boundaries 3:1. */
const PAIRS: [string, string[], number][] = [
  ['--color-text', [...BACKGROUNDS, '--color-raised', '--color-hover'], 4.5],
  ['--color-text-dim', [...BACKGROUNDS, '--color-hover'], 4.5],
  ['--color-muted', [...BACKGROUNDS, '--color-raised', '--color-hover'], 4.5],
  ['--color-accent', [...BACKGROUNDS, '--color-raised'], 4.5],
  ['--color-accent-ink', ['--color-accent'], 4.5],
  ['--color-selected-fg', ['--color-selected-bg'], 4.5],
  ['--color-warn', [...BACKGROUNDS, '--color-raised'], 4.5],
  ['--color-danger', [...BACKGROUNDS, '--color-raised'], 4.5],
  ['--color-danger-ink', ['--color-danger'], 4.5],
  ['--color-mention-fg', ['--color-mention-bg'], 4.5],
  ...[1, 2, 3, 4, 5, 6].map((i): [string, string[], number] => [`--user-${i}`, BACKGROUNDS, 4.5]),
  ['--color-focus', [...BACKGROUNDS, '--color-raised'], 3],
  ['--color-control-border', ['--color-bg', '--color-surface', '--color-raised'], 3],
]

describe('contrast helpers', () => {
  it('match the WCAG reference values', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#000000')).toBe(0)
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5)
  })

  it('rejects colours it cannot measure', () => {
    expect(() => relativeLuminance('rgb(0 0 0 / .5)')).toThrow()
  })
})

describe.each([...THEMES])('theme %s', (theme) => {
  const tokens = themeTokens(theme)

  it('declares its color-scheme', () => {
    expect(tokensCss).toMatch(new RegExp(String.raw`\[data-theme=["']?${theme}["']?\]\s*\{[^}]*color-scheme:\s*${theme === 'console' ? 'dark' : 'light'}`))
  })

  it.each(PAIRS)('%s reaches the contrast minimum', (fg, bgs, min) => {
    for (const bg of bgs) {
      expect(tokens[fg], `${fg} missing`).toBeDefined()
      expect(tokens[bg], `${bg} missing`).toBeDefined()
      const ratio = contrastRatio(tokens[fg], tokens[bg])
      expect(ratio, `${theme}: ${fg} ${tokens[fg]} on ${bg} ${tokens[bg]} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min)
    }
  })
})
