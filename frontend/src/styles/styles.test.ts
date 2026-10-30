import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const STYLES = dirname(fileURLToPath(import.meta.url))
const SRC = join(STYLES, '..')

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.name.endsWith('.css') ? [path] : []
  })
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Physical, direction-bound CSS: everything must be written with logical properties. */
const PHYSICAL: [string, RegExp][] = [
  // margin-left, padding-right, border-left(-color), scroll-margin-right, border-top-left-radius…
  ['physical property', /(^|[\s;{])[a-z-]*-(left|right)(-[a-z]+)*\s*:/m],
  ['left/right positioning', /(^|[\s;{])(left|right)\s*:/m],
  ['float/clear left/right', /\b(float|clear)\s*:\s*(left|right)\b/],
  ['text-align left/right', /\btext-align\s*:\s*(left|right)\b/],
  ['caption/resize side', /\bcaption-side\s*:\s*(left|right)\b/],
]

describe('styles', () => {
  const files = cssFiles(SRC)

  it('finds the design-system stylesheets', () => {
    const names = files.map((f) => relative(STYLES, f))
    expect(names).toEqual(expect.arrayContaining(['tokens.css', 'base.css', 'components.css']))
  })

  it('no physical left/right properties in src/styles', () => {
    const offences: string[] = []
    for (const file of files) {
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          for (const [what, pattern] of PHYSICAL) {
            if (pattern.test(line)) offences.push(`${relative(SRC, file)}:${i + 1} ${what}: ${line.trim()}`)
          }
        })
    }
    expect(offences).toEqual([])
  })

  it('the detector catches what it must', () => {
    const bad = ['margin-left: 0', 'a{padding-right:1px}', 'border-left: 1px solid', 'left: 0', ' right:2px',
      'float: left', 'text-align: right', 'border-top-left-radius: 2px', 'inset-left: 0']
    for (const line of bad) {
      expect(PHYSICAL.some(([, p]) => p.test(line)), line).toBe(true)
    }
    const good = ['margin-inline-start: 0', 'inset-inline-end: 0', 'text-align: start', 'border-start-start-radius: 2px',
      'background-position: center', '--gutter-inline: 1rem', 'content: "left"']
    for (const line of good) {
      expect(PHYSICAL.some(([, p]) => p.test(line)), line).toBe(false)
    }
  })

  it('declares the cascade layer order first', () => {
    const index = stripComments(readFileSync(join(STYLES, 'index.css'), 'utf8')).trim()
    expect(index.startsWith('@layer reset, tokens, base, components, utilities;')).toBe(true)
  })

  it('declares fonts with font-display: swap and self-hosted woff2 only', () => {
    const fonts = stripComments(readFileSync(join(STYLES, 'fonts.css'), 'utf8'))
    const faces = fonts.match(/@font-face\s*{[^}]*}/g) ?? []
    expect(faces.length).toBeGreaterThan(0)
    for (const face of faces) {
      expect(face).toMatch(/font-display:\s*swap/)
      expect(face).toMatch(/unicode-range:/)
      for (const [, url] of face.matchAll(/url\(([^)]+)\)/g)) {
        expect(url).toMatch(/^['"]?\/fonts\/[\w-]+\.woff2['"]?$/)
      }
    }
  })
})
