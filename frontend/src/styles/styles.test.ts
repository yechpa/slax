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

/**
 * Physical, direction-bound CSS: everything must be written with logical properties.
 *
 * Blind spots (not detectable from text alone, so reviewers must watch for them):
 * horizontal transforms (`translateX(4px)`, `translate: 4px 0`), horizontal
 * offsets in box-shadow / text-shadow, and `linear-gradient(to left|right)` /
 * `90deg` gradients: all physical, all legal CSS. Use them only for effects that
 * are symmetric or genuinely direction-free, and say so in a comment.
 */
const PHYSICAL: [string, RegExp][] = [
  // margin-left, padding-right, border-left(-color), scroll-margin-right, border-top-left-radius…
  ['physical property', /(^|[\s;{])[a-z-]*-(left|right)(-[a-z]+)*\s*:/m],
  ['left/right positioning', /(^|[\s;{])(left|right)\s*:/m],
  ['float/clear left/right', /\b(float|clear)\s*:\s*(left|right)\b/],
  ['text-align left/right', /\btext-align\s*:\s*(left|right)\b/],
  ['caption/resize side', /\bcaption-side\s*:\s*(left|right)\b/],
  ['left/right keyword in a position', /\b[a-z-]*position(-x)?\s*:[^;]*\b(left|right)\b/],
]

/** Shorthands whose 4-value form is top/right/bottom/left (or corner by corner): use the logical longhands. */
const FOUR_SIDED = /^(margin|padding|inset|scroll-margin|scroll-padding|border-width|border-style|border-color|border-radius)$/

/** Splits a CSS value on top-level whitespace, keeping calc(…)/var(…) whole. */
function topLevelValues(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value.trim()) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (/\s/.test(char) && depth === 0) {
      if (current) parts.push(current)
      current = ''
    } else current += char
  }
  if (current) parts.push(current)
  return parts.filter((p) => p !== '!important')
}

function fourValueShorthands(css: string): string[] {
  const found: string[] = []
  for (const [, property, value] of stripComments(css).matchAll(/(?:^|[;{\s])([a-z-]+)\s*:\s*([^;{}]+)/g)) {
    // border-radius: a / b (elliptical) is split per axis; each half counts.
    const halves = property === 'border-radius' ? value.split('/') : [value]
    if (FOUR_SIDED.test(property) && halves.some((half) => topLevelValues(half).length === 4)) {
      found.push(`${property}: ${value.trim()}`)
    }
  }
  return found
}

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
      for (const shorthand of fourValueShorthands(readFileSync(file, 'utf8'))) {
        offences.push(`${relative(SRC, file)} 4-value shorthand: ${shorthand}`)
      }
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
      'background-position: center', '--gutter-inline: 1rem', 'content: "left"', 'background-position: 0 0, 100% 0']
    for (const line of good) {
      expect(PHYSICAL.some(([, p]) => p.test(line)), line).toBe(false)
    }
    for (const line of ['background-position: left top', 'object-position: right', 'background-position-x: left']) {
      expect(PHYSICAL.some(([, p]) => p.test(line)), line).toBe(true)
    }
  })

  it('the detector catches 4-value margin/padding/inset/radius shorthands, and only those', () => {
    const bad = ['.a { margin: 0 0 0 4px; }', '.a{padding:1px 2px 3px 4px}', '.a { inset: 0 auto auto 0 }',
      '.a { border-radius: 2px 0 0 2px; }', '.a { margin: calc(1px * 2) 0 var(--x) 4px !important; }',
      '.a { border-radius: 1px / 1px 2px 3px 4px }']
    for (const css of bad) expect(fourValueShorthands(css), css).toHaveLength(1)
    const good = ['.a { margin: 0; padding: 1px 2px; inset: 0; }', '.a { padding: 1px 2px 3px; }',
      '.a { border-radius: var(--radius-1); }', '.a { margin: calc(1px + 2px) auto; }', '.a { font: 300 1em / 1.5 x, y }']
    for (const css of good) expect(fourValueShorthands(css), css).toEqual([])
  })

  it('every dynamic viewport height has a 100vh fallback just before it (older browsers drop the dvh line)', () => {
    const missing: string[] = []
    for (const file of files) {
      const css = stripComments(readFileSync(file, 'utf8'))
      for (const [, body] of css.matchAll(/\{([^{}]*)\}/g)) {
        const declarations = body.split(';').map((d) => d.trim()).filter(Boolean)
        declarations.forEach((declaration, i) => {
          if (!/\bdvh\b|\ddvh/.test(declaration)) return
          const [property] = declaration.split(':')
          const fallback = declaration.replace(/(\d)dvh/g, '$1vh')
          if (declarations[i - 1] !== fallback) missing.push(`${relative(SRC, file)}: ${declaration} (expected "${fallback}" before it, on ${property})`)
        })
      }
    }
    expect(missing).toEqual([])
  })

  it('sets the page up for touch screens: text size kept, a themed tap highlight, no page overscroll', () => {
    const css = files.map((file) => stripComments(readFileSync(file, 'utf8'))).join('\n')
    const html = [...css.matchAll(/(?:^|[{}])\s*html\s*\{([^}]*)\}/g)].map((m) => m[1]).join(';')
    // 100%, not none: none also disables the reader's own text zoom in some browsers.
    expect(html).toMatch(/-webkit-text-size-adjust:\s*100%/)
    expect(html).toMatch(/(?<!-)text-size-adjust:\s*100%/)
    expect(css).not.toMatch(/text-size-adjust:\s*none/)
    expect(html).toMatch(/-webkit-tap-highlight-color:\s*color-mix\([^;]*var\(--color-accent\)/)
    // Vertical only: horizontal overscroll is the browser's back/forward swipe.
    expect(html).toMatch(/overscroll-behavior-y:\s*none/)
    for (const scroller of ['.message-list', '.thread__log', '.sidebar__scroll', '.dialog__body']) {
      const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) => selector.split(',').some((s) => s.trim() === scroller))
      expect(rules.some(([, , body]) => /overscroll-behavior-y:\s*contain/.test(body)), scroller).toBe(true)
    }
  })

  it('reads the safe areas from env() once, the inline pair swapped for right to left', () => {
    const tokens = stripComments(readFileSync(join(STYLES, 'tokens.css'), 'utf8'))
    const block = (selector: string) => new RegExp(String.raw`${selector.replace(/[[\]]/g, '\\$&')}\s*\{([^}]*)\}`).exec(tokens)?.[1] ?? ''
    const root = block(':root')
    expect(root).toMatch(/--safe-top:\s*env\(safe-area-inset-top, 0px\)/)
    expect(root).toMatch(/--safe-bottom:\s*env\(safe-area-inset-bottom, 0px\)/)
    expect(root).toMatch(/--safe-inline-start:\s*env\(safe-area-inset-left, 0px\)/)
    expect(root).toMatch(/--safe-inline-end:\s*env\(safe-area-inset-right, 0px\)/)
    const rtl = block(":root[dir='rtl']")
    expect(rtl).toMatch(/--safe-inline-start:\s*env\(safe-area-inset-right, 0px\)/)
    expect(rtl).toMatch(/--safe-inline-end:\s*env\(safe-area-inset-left, 0px\)/)
    // Everything else pads with the variables (the e2e suite emulates a notch through them).
    for (const file of files.filter((f) => !f.endsWith('tokens.css'))) {
      expect(stripComments(readFileSync(file, 'utf8')), relative(SRC, file)).not.toMatch(/safe-area-inset/)
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
