// Captures the design-system kitchen sink in every theme × language for review.
// Runs inside the official Playwright image (see `make screenshots`); Playwright
// is installed there on the fly and is NOT a dependency of the app.
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const DIST = process.env.DIST ?? '/dist'
const OUT = process.env.OUT ?? '/out'
const PORT = 4173

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (req, res) => {
  const path = normalize(new URL(req.url, 'http://local').pathname).replace(/^(\.\.[/\\])+|^\/+/g, '')
  try {
    const body = await readFile(join(DIST, path || 'index.html'))
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

const desktop = { width: 1280, height: 900 }
const mobile = { width: 390, height: 844 }
const shots = []
for (const theme of ['console', 'listing']) {
  for (const lang of ['en', 'he', 'fr']) {
    shots.push({ file: `${theme}-${lang}.png`, theme, lang, viewport: desktop, fullPage: false })
    shots.push({ file: `full/${theme}-${lang}.png`, theme, lang, viewport: desktop, fullPage: true })
  }
}
shots.push({ file: 'mobile-console-fr.png', theme: 'console', lang: 'fr', viewport: mobile, fullPage: false, isMobile: true })

await mkdir(join(OUT, 'full'), { recursive: true })
const browser = await chromium.launch()
const failures = []
for (const shot of shots) {
  const context = await browser.newContext({
    viewport: shot.viewport,
    deviceScaleFactor: 1,
    isMobile: shot.isMobile ?? false,
    hasTouch: shot.isMobile ?? false,
    colorScheme: shot.theme === 'console' ? 'dark' : 'light',
    reducedMotion: 'reduce', // the block cursor holds still: stable images
    locale: shot.lang,
  })
  const page = await context.newPage()
  page.on('console', (msg) => msg.type() === 'error' && failures.push(`${shot.file}: ${msg.text()}`))
  page.on('pageerror', (err) => failures.push(`${shot.file}: ${err.message}`))
  page.on('requestfailed', (req) => failures.push(`${shot.file}: request failed ${req.url()}`))
  await page.goto(`http://127.0.0.1:${PORT}/design-system.html?theme=${shot.theme}&lang=${shot.lang}`)
  await page.evaluate(async () => {
    await Promise.all([document.fonts.load('300 1em "Cascadia Mono"', 'שלום'), document.fonts.load('700 1em "Cascadia Mono"', 'שלום')])
    await document.fonts.ready
  })
  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length)
  await page.screenshot({ path: join(OUT, shot.file), fullPage: shot.fullPage })
  console.log(`${shot.file}  (${fonts} font files loaded)`)
  await context.close()
}
await browser.close()
server.close()
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
