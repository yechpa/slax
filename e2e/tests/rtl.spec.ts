/**
 * Right to left, checked on geometry (never on pixels): in Hebrew the sidebar is on the right,
 * the thread opens on the left, arrows point the other way and the keyboard follows them,
 * nothing overflows off the left edge, and a channel name or a mention stays one unit
 * ("#general", never "general#"). English is the control: the same checks, mirrored.
 *
 * Reference screenshots for review are attached to the report; with E2E_SCREENSHOTS=1 they
 * are also written to docs/design/e2e/ (they hold times and names, so they are not
 * rewritten on every run).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { api, closeAll, openChannel, reload, signIn, ui, type Person } from '../support/app.ts'
import { dirOf, t, type Locale, type Theme } from '../support/i18n.ts'

const SCREENSHOTS = join(__dirname, '../../docs/design/e2e')

type Box = { ch: string; left: number; right: number }

/** Where each character of an element's text is drawn (one Range per UTF-16 unit, astral pairs skipped). */
async function charBoxes(locator: Locator): Promise<Box[]> {
  return locator.evaluate((element) => {
    const boxes: { ch: string; left: number; right: number }[] = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? ''
      for (let i = 0; i < text.length; i += 1) {
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + 1)
        const rect = range.getBoundingClientRect()
        if (rect.width > 0) boxes.push({ ch: text[i] ?? '', left: rect.left, right: rect.right })
      }
    }
    return boxes
  })
}

/** The horizontal box of the `nth` occurrence of a character in an element's text. */
async function charAt(locator: Locator, ch: string, nth = 0): Promise<Box> {
  const found = (await charBoxes(locator)).filter((box) => box.ch === ch)[nth]
  if (!found) throw new Error(`No "${ch}" drawn in ${String(locator)}`)
  return found
}

/** "#name" (or "@name") reads sigil first: on the left for a Latin name, on the right for a Hebrew one. */
async function expectOneUnit(locator: Locator, sigil: string, firstLetter: string, rtlName = false): Promise<void> {
  const mark = await charAt(locator, sigil)
  const letter = await charAt(locator, firstLetter)
  if (rtlName) expect(mark.left, `${sigil} on the right of ${firstLetter}`).toBeGreaterThan(letter.left)
  else expect(mark.right, `${sigil} on the left of ${firstLetter}`).toBeLessThanOrEqual(letter.left + 0.5)
}

const rect = (locator: Locator) =>
  locator.evaluate((element) => {
    const r = element.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }
  })

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const offenders: string[] = []
    for (const element of [document.documentElement, ...document.querySelectorAll<HTMLElement>('.message-list, .thread__log, .sidebar__scroll')]) {
      if (element.scrollWidth > element.clientWidth + 1) offenders.push(element.className || element.tagName)
    }
    return offenders
  })
  expect(overflow, 'nothing scrolls sideways (in RTL, an overflow would hang off the unreachable left)').toEqual([])
}

const combos: [Locale, Theme][] = [
  ['he', 'console'],
  ['he', 'listing'],
  ['en', 'console'],
]

for (const [locale, theme] of combos) {
  test(`${locale === 'he' ? 'right to left' : 'left to right (control)'}: ${locale}, ${theme}`, async ({ browser }, testInfo) => {
    const rtl = dirOf(locale) === 'rtl'
    let reader: Person | undefined
    let dana: Person | undefined
    try {
      // Fixed display names and channel, for comparable screenshots (a fresh database each
      // `make e2e`; a retry reuses the channel, hence the newest message of each kind below).
      reader = await signIn(browser, 'נועה', { locale, theme })
      dana = await signIn(browser, 'Dana')
      const room = `bidi-${locale}-${theme}`
      const existing = (await api(reader.page).get<{ id: number; name: string | null }[]>('/channels')).find((c) => c.name === room)
      const channel = existing ?? (await api(reader.page).createChannel(room, 'public', 'Mixed directions: English topic'))
      await api(dana.page).join(channel.id)
      const english = await api(dana.page).postMessage(channel.id, 'Ship it when everything is green.')
      await api(reader.page).postMessage(channel.id, 'שלום @Dana, ראית את #general? הכל ירוק.')
      await api(dana.page).postMessage(channel.id, 'Thanks @נועה, see #general and https://example.test/a?b=1 for details.')
      await api(reader.page).postMessage(channel.id, 'תשובה בשרשור', english.id)
      await reload(reader)
      await openChannel(reader, room)
      const page = reader.page
      const view = ui(reader)
      await expect(page.locator('html')).toHaveAttribute('dir', dirOf(locale))
      const width = page.viewportSize()?.width ?? 0

      // --- The sidebar sits at the inline start: right in Hebrew, left in English.
      const nav = await rect(view.nav)
      const main = await rect(page.locator('.shell__main'))
      if (rtl) {
        expect(nav.right).toBeGreaterThanOrEqual(width - 1)
        expect(nav.left).toBeGreaterThan(width / 2)
        expect(main.right).toBeLessThanOrEqual(nav.left + 1)
      } else {
        expect(nav.left).toBeLessThanOrEqual(1)
        expect(nav.right).toBeLessThan(width / 2)
        expect(main.left).toBeGreaterThanOrEqual(nav.right - 1)
      }

      // --- Channel names and mentions are one unit, whatever the sentence around them.
      await expectOneUnit(view.header.locator('.channel-header__name'), '#', 'b')
      await expectOneUnit(page.locator('.shell__footer .composer__placeholder'), '#', 'b')
      const hebrew = view.sent('שלום').last()
      await expectOneUnit(hebrew.locator('.mention'), '@', 'D')
      await expectOneUnit(hebrew.locator('.message__body'), '#', 'g')
      const latin = view.sent('Thanks').last()
      await expectOneUnit(latin.locator('.mention'), '@', 'נ', true)
      await expectOneUnit(latin.locator('.message__body'), '#', 'g')

      // --- The thread link's arrow leads the line and points the reading way ("->" mirrored: "<-").
      const english1 = view.sent('Ship it').last()
      const link = english1.locator('.thread-link')
      await expect(link).toHaveCSS('direction', dirOf(locale))
      const arrow = await rect(link.locator('span[aria-hidden="true"]'))
      const count = await rect(link.locator('.thread-link__count'))
      if (rtl) expect(arrow.left).toBeGreaterThan(count.left)
      else expect(arrow.left).toBeLessThan(count.left)
      const dash = await charAt(link, '-')
      const head = await charAt(link, '>')
      if (rtl) expect(head.left, 'the arrowhead is drawn on the left').toBeLessThan(dash.left)
      else expect(head.left, 'the arrowhead is drawn on the right').toBeGreaterThan(dash.left)

      // --- The reply arrow of a message's quick actions turns the same way.
      await english1.hover()
      const replyButton = english1.getByRole('button', { name: t(locale, 'action.reply'), exact: true })
      const replyDash = await charAt(replyButton, '-')
      const replyHead = await charAt(replyButton, '>')
      if (rtl) expect(replyHead.left).toBeLessThan(replyDash.left)
      else expect(replyHead.left).toBeGreaterThan(replyDash.left)

      // --- The emoji grid: the arrow key pointing forward moves to the next emoji, drawn on that side.
      await english1.getByRole('button', { name: t(locale, 'action.react'), exact: true }).click()
      const items = page.locator('.popover--placed .emoji-picker__item')
      await expect(items.first()).toBeFocused()
      await page.keyboard.press(rtl ? 'ArrowLeft' : 'ArrowRight')
      await expect(items.nth(1)).toBeFocused()
      const first = await rect(items.nth(0))
      const second = await rect(items.nth(1))
      if (rtl) expect(second.right).toBeLessThanOrEqual(first.left + 1)
      else expect(second.left).toBeGreaterThanOrEqual(first.right - 1)
      await page.keyboard.press(rtl ? 'ArrowRight' : 'ArrowLeft')
      await expect(items.first()).toBeFocused()
      await page.keyboard.press('Escape')

      await noHorizontalOverflow(page)
      await attachShot(page, testInfo, `${locale}-${theme}-channel`)

      // --- The thread opens at the inline end: on the left in Hebrew.
      await link.click()
      await expect(view.thread).toBeVisible()
      await expect(view.reply('תשובה בשרשור').last()).toBeVisible()
      const thread = await rect(view.thread)
      const list = await rect(view.log)
      if (rtl) expect(thread.right).toBeLessThanOrEqual(list.left + 1)
      else expect(thread.left).toBeGreaterThanOrEqual(list.right - 1)
      await noHorizontalOverflow(page)
      await attachShot(page, testInfo, `${locale}-${theme}-thread`)
    } finally {
      await closeAll(reader, dana)
    }
  })
}

/** Attached to the report always; written to docs/design/e2e/ with E2E_SCREENSHOTS=1. */
async function attachShot(page: Page, testInfo: { attach: (name: string, options: { body: Buffer; contentType: string }) => Promise<void> }, name: string) {
  const body = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  await testInfo.attach(name, { body, contentType: 'image/png' })
  if (process.env.E2E_SCREENSHOTS === '1') {
    mkdirSync(SCREENSHOTS, { recursive: true })
    await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`), animations: 'disabled', caret: 'hide' })
  }
}
