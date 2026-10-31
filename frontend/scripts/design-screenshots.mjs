// Captures the design-system kitchen sink, and the application itself on fixtures
// (app-preview.html), in every theme × language for review.
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
const appDesktop = { width: 1280, height: 800 }
const mobile = { width: 390, height: 844 }
const sink = (theme, lang) => `/design-system.html?theme=${theme}&lang=${lang}`
const app = (theme, lang, extra = '') => `/app-preview.html?screen=app&theme=${theme}&lang=${lang}${extra}`
const signIn = (theme, lang, extra = '') => `/app-preview.html?screen=signed-out&theme=${theme}&lang=${lang}${extra}`
const openDrawer = async (page) => {
  await page.click('.channel-header__nav')
  await page.waitForSelector('.shell--nav-open')
}
const settle = (page) => page.waitForTimeout(150)
// Part B interactions (the fixture's messages: see src/design-system/app-fixtures.ts).
const openThread = async (page) => {
  await page.click('.thread-link >> nth=0')
  await page.waitForSelector('.thread .thread__parent')
  await page.waitForSelector('.thread .message-list__row')
  await settle(page)
}
const openDeletedThread = async (page) => {
  await page.click('.message--deleted .thread-link')
  await page.waitForSelector('.thread .thread__parent .tombstone')
  await settle(page)
}
const messageItem = (page, index) => page.locator('.message-list .message-item').nth(index)
const openPicker = async (page) => {
  const item = messageItem(page, 4)
  await item.hover()
  await item.locator('.message-actions__quick').first().click()
  await page.waitForSelector('.popover--placed .emoji-picker')
}
const openMenu = async (page) => {
  const item = messageItem(page, 5)
  await item.hover()
  await item.locator('.message-actions__more').click()
  await page.waitForSelector('.popover--placed .menu')
}
const startEdit = async (page) => {
  await openMenu(page)
  await page.click('.menu__item >> nth=2')
  await page.waitForSelector('.message-editor')
  await page.keyboard.type(' (edited from the menu)')
}
const confirmDelete = async (page) => {
  await openMenu(page)
  await page.click('.menu__item--danger')
  await page.waitForSelector('dialog[open]')
  await settle(page)
}
const newMessage = async (page) => {
  await page.click('.nav-item--action >> nth=2')
  await page.waitForSelector('dialog[open] .people-picker__input')
  await page.fill('.people-picker__input', 'da')
  await page.waitForSelector('.people-picker__option')
  await page.keyboard.press('Enter')
  await page.keyboard.type('d')
  await page.waitForSelector('.people-picker__option')
  await settle(page)
}
const createChannel = async (page) => {
  await page.click('.nav-item--action >> nth=0')
  await page.waitForSelector('dialog[open] input')
  await page.keyboard.type('Release_Notes')
  await page.waitForSelector('.field__error')
}
const browseChannels = async (page) => {
  await page.click('.nav-item--action >> nth=1')
  await page.waitForSelector('dialog[open] .browse__list')
}
const channelDetails = async (page) => {
  await page.click('.channel-header__details')
  await page.waitForSelector('dialog[open] .details__member')
  await settle(page)
}
const attachFiles = async (page) => {
  const bytes = (n) => Buffer.alloc(n, 1)
  await page.setInputFiles('.shell__footer .composer__picker', [
    { name: 'deploy-notes.pdf', mimeType: 'application/pdf', buffer: bytes(182_000) },
    { name: 'architecture-diagram.png', mimeType: 'image/png', buffer: bytes(640_000) },
    { name: 'logs-archive.zip', mimeType: 'application/zip', buffer: bytes(52_000) },
  ])
  await page.waitForSelector('.composer .file-chip--error')
  await page.waitForSelector('.composer .file-chip--uploading')
  await page.fill('.shell__footer .composer__input', 'Notes and the diagram for the review')
  await settle(page)
}
// Touch: the "more" button is always there (no hover), and opens the whole menu.
const mobileMenu = async (page) => {
  const item = messageItem(page, 5)
  await item.scrollIntoViewIfNeeded()
  await item.locator('.message-actions__more').click()
  await page.waitForSelector('.popover--placed .menu')
}
const mobileNewMessage = async (page) => {
  await openDrawer(page)
  await newMessage(page)
}
const dragFiles = async (page) => {
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['x'], 'screenshot.png', { type: 'image/png' }))
    document.querySelector('.message-list').dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
  await page.waitForSelector('.drop-zone__overlay')
}
// Administration (?admin=1): reached from the account menu, as an administrator does.
const openAdmin = async (page) => {
  await page.click('.user-menu__toggle')
  await page.click('.user-menu__admin')
  await page.waitForSelector('.admin-status__row')
  await settle(page)
}
const adminTab = (index, ready) => async (page) => {
  await openAdmin(page)
  await page.click(`.admin__tab >> nth=${index}`)
  await page.waitForSelector(ready)
  await settle(page)
}
const adminAudit = adminTab(1, '.admin-table tbody tr')
const adminModeration = adminTab(2, '.admin-list__row')
const adminMessageMenu = async (page) => {
  const item = messageItem(page, 4)
  await item.hover()
  await item.locator('.message-actions__more').click()
  await page.waitForSelector('.popover--placed .menu')
}
// Every theme × language is loaded and checked at both widths; only some are saved.
const shots = []
for (const theme of ['console', 'listing']) {
  for (const lang of ['en', 'he', 'fr']) {
    shots.push({ url: sink(theme, lang), files: [`${theme}-${lang}.png`, `full/${theme}-${lang}.png`], theme, lang, viewport: desktop })
    const saveMobile = theme === 'console' && lang === 'fr'
    shots.push({ url: sink(theme, lang), files: saveMobile ? ['mobile-console-fr.png'] : [], theme, lang, viewport: mobile, isMobile: true })
    // The application (docs/design/app/).
    shots.push({ url: signIn(theme, lang), files: [`app/signin-${theme}-${lang}.png`], theme, lang, viewport: appDesktop, ready: '.signin__google' })
    shots.push({ url: app(theme, lang), files: [`app/shell-${theme}-${lang}.png`], theme, lang, viewport: appDesktop, ready: '.message__body' })
    const appMobile = (theme === 'console' && lang === 'fr') || (theme === 'listing' && lang === 'he')
    shots.push({ url: app(theme, lang), files: appMobile ? [`app/mobile-${theme}-${lang}.png`] : [], theme, lang, viewport: mobile, isMobile: true, ready: '.message__body' })
    shots.push({ url: app(theme, lang), files: appMobile ? [`app/mobile-nav-${theme}-${lang}.png`] : [], theme, lang, viewport: mobile, isMobile: true, ready: '.message__body', before: openDrawer })
    shots.push({ url: signIn(theme, lang), files: appMobile ? [`app/mobile-signin-${theme}-${lang}.png`] : [], theme, lang, viewport: mobile, isMobile: true, ready: '.signin__google' })
  }
}
// Part B: threads, reactions, files, dialogs, typing and presence.
const partB = [
  ['thread', openThread],
  ['thread-deleted-parent', openDeletedThread],
  ['reaction-picker', openPicker],
  ['message-menu', openMenu],
  ['edit', startEdit],
  ['delete-confirm', confirmDelete],
  ['new-message', newMessage],
  ['create-channel', createChannel],
  ['browse-channels', browseChannels],
  ['channel-details', channelDetails],
  ['files-upload', attachFiles],
  ['files-drop', dragFiles],
]
for (const lang of ['en', 'he']) {
  for (const [name, before] of partB) {
    shots.push({ url: app('console', lang), files: [`app/${name}-console-${lang}.png`], theme: 'console', lang, viewport: appDesktop, ready: '.message__body', before })
  }
}
for (const name of ['thread', 'thread-deleted-parent', 'new-message', 'create-channel', 'browse-channels', 'channel-details', 'files-upload']) {
  const before = partB.find(([n]) => n === name)[1]
  shots.push({ url: app('listing', 'fr'), files: [`app/${name}-listing-fr.png`], theme: 'listing', lang: 'fr', viewport: appDesktop, ready: '.message__body', before })
}
// Every other combination is still loaded and checked with a thread and a dialog open.
for (const [theme, lang] of [['console', 'fr'], ['listing', 'en'], ['listing', 'he']]) {
  shots.push({ url: app(theme, lang), files: [], theme, lang, viewport: appDesktop, ready: '.message__body', before: openThread })
  shots.push({ url: app(theme, lang), files: [], theme, lang, viewport: appDesktop, ready: '.message__body', before: newMessage })
}
for (const [theme, lang] of [['console', 'fr'], ['listing', 'he']]) {
  shots.push({ url: app(theme, lang), files: [`app/mobile-thread-${theme}-${lang}.png`], theme, lang, viewport: mobile, isMobile: true, ready: '.message__body', before: openThread })
  shots.push({ url: app(theme, lang), files: [`app/mobile-menu-${theme}-${lang}.png`], theme, lang, viewport: mobile, isMobile: true, ready: '.message__body', before: mobileMenu })
  shots.push({ url: app(theme, lang), files: [`app/mobile-new-message-${theme}-${lang}.png`], theme, lang, viewport: mobile, isMobile: true, ready: '.message__body', before: mobileNewMessage })
}
shots.push({ url: signIn('listing', 'fr', '&auth_error=provider_error'), files: ['app/signin-error-listing-fr.png'], theme: 'listing', lang: 'fr', viewport: appDesktop, ready: '.signin__error' })
shots.push({ url: app('console', 'en'), files: ['app/shell-menu-console-en.png'], theme: 'console', lang: 'en', viewport: appDesktop, ready: '.message__body', before: (page) => page.click('.user-menu__toggle') })

const adminApp = (theme, lang) => app(theme, lang, '&admin=1')
for (const [theme, lang] of [['console', 'en'], ['console', 'he'], ['listing', 'fr']]) {
  shots.push({ url: adminApp(theme, lang), files: [`app/admin-status-${theme}-${lang}.png`], theme, lang, viewport: appDesktop, ready: '.message__body', before: openAdmin })
  shots.push({ url: adminApp(theme, lang), files: [`app/admin-audit-${theme}-${lang}.png`], theme, lang, viewport: appDesktop, ready: '.message__body', before: adminAudit })
  shots.push({ url: adminApp(theme, lang), files: [`app/admin-moderation-${theme}-${lang}.png`], theme, lang, viewport: appDesktop, ready: '.message__body', before: adminModeration })
}
shots.push({ url: adminApp('console', 'en'), files: ['app/admin-message-menu-console-en.png'], theme: 'console', lang: 'en', viewport: appDesktop, ready: '.message__body', before: adminMessageMenu })
shots.push({ url: adminApp('console', 'fr'), files: ['app/mobile-admin-console-fr.png'], theme: 'console', lang: 'fr', viewport: mobile, isMobile: true, ready: '.message__body', before: async (page) => {
  await openDrawer(page)
  await openAdmin(page)
} })

/** Runs in the page: anything clipped that must not be. */
function layoutProblems() {
  const problems = []
  const root = document.documentElement
  if (root.scrollWidth > root.clientWidth) problems.push(`page scrolls sideways: ${root.scrollWidth}px > ${root.clientWidth}px`)
  const canvas = document.createElement('canvas').getContext('2d')
  for (const input of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    if (!input.offsetParent || !input.placeholder) continue
    const style = getComputedStyle(input)
    canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const room = input.clientWidth - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd)
    const needed = canvas.measureText(input.placeholder).width
    if (needed > room + 0.5) problems.push(`placeholder clipped (${Math.round(needed)}px in ${Math.round(room)}px): ${input.placeholder}`)
  }
  for (const el of document.querySelectorAll('.composer__placeholder')) {
    if (el.scrollWidth > el.clientWidth + 1) problems.push(`composer placeholder clipped: ${el.textContent}`)
  }
  // Phones: every control of the app is at least 44px tall (links inside text excepted).
  if (document.documentElement.clientWidth < 700 && document.querySelector('.shell--app')) {
    const controls = document.querySelectorAll(
      '.shell--app button, .shell--app a.nav-item, dialog button, dialog input, .popover button',
    )
    for (const el of controls) {
      if (!el.offsetParent || el.closest('[inert]') || el.matches('.composer__input, .message-editor__input')) continue
      const box = el.getBoundingClientRect()
      if (box.width === 0) continue
      if (box.height < 43.5) problems.push(`touch target ${Math.round(box.height)}px tall: ${el.className || el.tagName} "${el.textContent.trim().slice(0, 30)}"`)
    }
  }
  return problems
}

await mkdir(join(OUT, 'full'), { recursive: true })
await mkdir(join(OUT, 'app'), { recursive: true })
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
  page.on('console', (msg) => msg.type() === 'error' && failures.push(`${shot.theme}/${shot.lang}: ${msg.text()}`))
  page.on('pageerror', (err) => failures.push(`${shot.theme}/${shot.lang}: ${err.message}`))
  page.on('requestfailed', (req) => failures.push(`${shot.theme}/${shot.lang}: request failed ${req.url()}`))
  await page.goto(`http://127.0.0.1:${PORT}${shot.url}`)
  if (shot.ready) await page.waitForSelector(shot.ready)
  // The app polls presence shortly after showing people: let it answer.
  if (shot.url.includes('screen=app')) await page.waitForTimeout(500)
  await page.evaluate(async () => {
    await Promise.all([document.fonts.load('300 1em "Cascadia Mono"', 'שלום'), document.fonts.load('700 1em "Cascadia Mono"', 'שלום')])
    await document.fonts.ready
  })
  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length)
  if (shot.before) await shot.before(page)
  const label = `${shot.url.split('?')[0]} ${shot.theme}/${shot.lang} @${shot.viewport.width}px`
  for (const problem of await page.evaluate(layoutProblems)) failures.push(`${label}: ${problem}`)
  for (const file of shot.files) {
    await page.screenshot({ path: join(OUT, file), fullPage: file.startsWith('full/') })
  }
  console.log(`${label}  checked, ${fonts} font files loaded${shot.files.length ? `, saved ${shot.files.join(' ')}` : ''}`)
  await context.close()
}
await browser.close()
server.close()
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
