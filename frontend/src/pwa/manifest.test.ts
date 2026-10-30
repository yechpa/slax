// @vitest-environment node
/**
 * What makes Slax installable: the web app manifest, its icons (rendered from favicon.svg by
 * `make icons`), and the page's metadata for iOS and the browser's chrome colour.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { THEME_COLORS } from '../theme.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PUBLIC = join(ROOT, 'public')
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'))
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8')
const tokens = readFileSync(join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')

/** The theme's page background, from tokens.css. */
function background(theme: string): string {
  const block = tokens.match(new RegExp(`\\[data-theme='${theme}'\\]\\s*\\{([^}]*)\\}`))?.[1] ?? ''
  return block.match(/--color-bg:\s*(#[0-9a-f]{6})/i)?.[1] ?? ''
}

/** Width, height and the top-left pixel's alpha of a PNG (8-bit RGB/RGBA, any filter). */
function png(path: string): { width: number; height: number; cornerAlpha: number } {
  const data = readFileSync(path)
  expect(data.subarray(1, 4).toString('latin1')).toBe('PNG')
  const width = data.readUInt32BE(16)
  const height = data.readUInt32BE(20)
  const bitDepth = data[24]
  const colorType = data[25]
  expect(bitDepth).toBe(8)
  const idat: Buffer[] = []
  for (let offset = 8; offset < data.length; ) {
    const length = data.readUInt32BE(offset)
    const type = data.subarray(offset + 4, offset + 8).toString('latin1')
    if (type === 'IDAT') idat.push(data.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  // Row 0, pixel 0 (after the filter byte): every PNG filter leaves the first pixel of the first row as is.
  const cornerAlpha = colorType === 6 ? raw[4] : colorType === 2 ? 255 : -1
  return { width, height, cornerAlpha }
}

describe('web app manifest', () => {
  it('names the app and opens it standalone, on the whole origin', () => {
    expect(manifest).toMatchObject({
      id: '/',
      name: 'Slax',
      short_name: 'Slax',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      lang: 'en',
      dir: 'auto',
    })
    expect(manifest.description).toEqual(expect.any(String))
  })

  it("takes its colours from the console theme's background (the default theme)", () => {
    expect(background('console')).toMatch(/^#/)
    expect(manifest.theme_color).toBe(background('console'))
    expect(manifest.background_color).toBe(background('console'))
  })

  it('lists 192 and 512 icons, and a maskable one, each of the size it claims', () => {
    const icons: { src: string; sizes: string; type: string; purpose?: string }[] = manifest.icons
    const by = (sizes: string, purpose = 'any') => icons.find((icon) => icon.sizes === sizes && (icon.purpose ?? 'any') === purpose)
    expect(by('192x192')).toBeDefined()
    expect(by('512x512')).toBeDefined()
    expect(by('512x512', 'maskable')).toBeDefined()
    for (const icon of icons) {
      expect(icon.type).toBe('image/png')
      expect(icon.src).toMatch(/^\/icons\/[a-z0-9-]+\.png$/)
      const { width, height } = png(join(PUBLIC, icon.src))
      expect(`${width}x${height}`).toBe(icon.sizes)
    }
  })

  it('has a maskable icon that is opaque to the edge (a launcher crops it to any shape)', () => {
    const maskable = manifest.icons.find((icon: { purpose?: string }) => icon.purpose === 'maskable')
    expect(png(join(PUBLIC, maskable.src)).cornerAlpha).toBe(255)
  })
})

describe('icons', () => {
  it('has an opaque 180x180 apple-touch-icon (iOS shows transparency as black)', () => {
    expect(png(join(PUBLIC, 'icons', 'apple-touch-icon.png'))).toEqual({ width: 180, height: 180, cornerAlpha: 255 })
  })

  it('were rendered from the current favicon.svg (run `make icons` after changing it)', () => {
    const source = createHash('sha256').update(readFileSync(join(PUBLIC, 'favicon.svg'))).digest('hex')
    expect(readFileSync(join(ROOT, 'scripts', 'icons.source.sha256'), 'utf8').trim()).toBe(source)
  })
})

describe('index.html', () => {
  it('links the manifest and the iOS home screen icon and title', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />')
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-title" content="Slax" />')
    expect(existsSync(join(PUBLIC, 'icons', 'apple-touch-icon.png'))).toBe(true)
  })

  it('lets the page reach the screen edges (safe areas are padded by the styles)', () => {
    expect(indexHtml).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*" \/>/)
  })

  it('asks Android to resize the page for the keyboard, and never stops anyone zooming', () => {
    const content = /<meta name="viewport" content="([^"]*)" \/>/.exec(indexHtml)?.[1] ?? ''
    expect(content.split(',').map((part) => part.trim())).toEqual(
      expect.arrayContaining(['width=device-width', 'initial-scale=1', 'viewport-fit=cover', 'interactive-widget=resizes-content']),
    )
    expect(content).not.toMatch(/user-scalable|maximum-scale/)
  })

  it('colours the browser chrome per colour scheme before the script runs, in the theme colours', () => {
    expect(indexHtml).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${background('console')}" />`)
    expect(indexHtml).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${background('listing')}" />`)
  })

  it('theme.ts knows the same colours', () => {
    expect(THEME_COLORS).toEqual({ console: background('console'), listing: background('listing') })
  })
})
