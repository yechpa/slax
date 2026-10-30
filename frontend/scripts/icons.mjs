// Renders the install icons (public/icons/*.png) from public/favicon.svg, and records the
// source's hash in scripts/icons.source.sha256 (src/pwa/manifest.test.ts fails when the
// favicon changed and the icons were not rendered again).
// Runs inside the official Playwright image (see `make icons`); Playwright is installed there
// on the fly and is NOT a dependency of the app. Same image, same SVG: same PNG bytes.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const PUBLIC = process.env.PUBLIC_DIR ?? '/public'
const SCRIPTS = process.env.SCRIPTS_DIR ?? '/scripts'
// The console theme's background (--color-bg, tokens.css), behind the opaque icons.
const BACKGROUND = '#0b0f0d'

// logo: the share of the icon's width the logo takes; background: null keeps transparency.
const ICONS = [
  // "any" icons, shown as they are: the logo with a little margin.
  { file: 'icon-192.png', size: 192, logo: 0.84, background: null },
  { file: 'icon-512.png', size: 512, logo: 0.84, background: null },
  // Maskable: full bleed, the logo inside the safe zone (the centre circle of 80% diameter).
  { file: 'icon-maskable-512.png', size: 512, logo: 0.56, background: BACKGROUND },
  // iOS home screen: opaque (iOS fills transparency with black and rounds the corners itself).
  { file: 'apple-touch-icon.png', size: 180, logo: 0.7, background: BACKGROUND },
]

const svg = await readFile(join(PUBLIC, 'favicon.svg'))
const source = `data:image/svg+xml;base64,${svg.toString('base64')}`
await mkdir(join(PUBLIC, 'icons'), { recursive: true })

const browser = await chromium.launch()
try {
  for (const { file, size, logo, background } of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    const box = Math.round(size * logo)
    await page.setContent(
      `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${background ?? 'transparent'}">` +
        `<img src="${source}" style="width:${box}px;height:${box}px;object-fit:contain" alt=""></body></html>`,
    )
    await page.locator('img').evaluate((img) => img.decode())
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: background === null })
    await writeFile(join(PUBLIC, 'icons', file), png)
    await page.close()
    console.log(`icons/${file} (${size}x${size})`)
  }
} finally {
  await browser.close()
}

await writeFile(join(SCRIPTS, 'icons.source.sha256'), `${createHash('sha256').update(svg).digest('hex')}\n`)
