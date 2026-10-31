import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrastRatio, relativeLuminance } from '../lib/contrast.ts'
import { THEMES, type Theme } from '../theme.ts'

const styles = dirname(fileURLToPath(import.meta.url))
const tokensCss = readFileSync(join(styles, 'tokens.css'), 'utf8')
const componentsCss = readFileSync(join(styles, 'components.css'), 'utf8')

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

/** A colour laid at `alpha` over an opaque one (how a color-mix(… x%, transparent) background is painted). */
function over(colour: string, alpha: number, base: string): string {
  const parse = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16))
  const top = parse(colour)
  const bottom = parse(base)
  return `#${top.map((c, i) => Math.round(c * alpha + (bottom[i] ?? 0) * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}

/** The accent tint a rule paints a message with, read from components.css (e.g. 5 for 5%). */
function messageTint(selector: string): number {
  const rule = new RegExp(String.raw`${selector.replace(/[.:]/g, '\\$&')}[^{]*\{[^}]*color-mix\(in srgb, var\(--color-accent\) (\d+)%, transparent\)`).exec(componentsCss)
  if (!rule?.[1]) throw new Error(`no accent tint on ${selector}`)
  return Number(rule[1]) / 100
}

/*
 * Phone surfaces. A tap leaves a message hovered (a touch screen keeps :hover until the next
 * tap) or focused, so its text, author, links and the always-visible "more" button sit on the
 * accent tint; a mentioned message has its own tint. In the open message menu, a tapped item is
 * the accent (or the danger colour) on the hover background.
 */
describe.each([...THEMES])('theme %s, phone surfaces', (theme) => {
  const tokens = themeTokens(theme)
  const tints = { hovered: messageTint('.message:hover'), mentioned: messageTint('.message--mentioned') }
  const foregrounds = ['--color-text', '--color-text-dim', '--color-muted', '--color-link', '--color-danger', ...[1, 2, 3, 4, 5, 6].map((i) => `--user-${i}`)]

  it.each(Object.entries(tints))('everything in a %s message stays readable on its tint', (_, alpha) => {
    for (const base of ['--color-bg', '--color-band-a', '--color-band-b']) {
      const background = over(tokens['--color-accent']!, alpha, tokens[base]!)
      for (const fg of foregrounds) {
        const ratio = contrastRatio(tokens[fg]!, background)
        expect(ratio, `${theme}: ${fg} on ${base} + ${alpha * 100}% accent (${background}) = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('a tapped menu item stays readable', () => {
    for (const fg of ['--color-accent', '--color-danger', '--color-text']) {
      const ratio = contrastRatio(tokens[fg]!, tokens['--color-hover']!)
      expect(ratio, `${theme}: ${fg} on --color-hover = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
