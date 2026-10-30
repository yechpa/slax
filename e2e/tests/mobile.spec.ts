/**
 * Slax on a phone, in emulation (projects `iphone`: WebKit as an iPhone 14, and `pixel`: Chromium
 * as a Pixel 7; see playwright.config.ts): what an iPhone or an Android phone gets wrong unless it
 * is designed for. Fields large enough not to zoom on focus; the app as tall as the screen that
 * is actually visible (the dynamic viewport, then what the on-screen keyboard leaves); the notch
 * and the home indicator kept clear; fingers, not a mouse: 44 px targets and nothing that needs a
 * hover; nothing scrolling sideways at 375 and 360 px in English, Hebrew and French; the drawer
 * from the inline start; dialogs inside the screen. Then the core journey, by touch.
 *
 * Geometry and computed styles only (never pixels). What emulation cannot show (a real keyboard,
 * a real notch, Safari's own toolbars) is listed in docs/known-limitations.md for a real device.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { api, closeAll, isolated, realtimeSwitch, ui, uniq, type Person } from '../support/app.ts'
import { plural, t, type Locale, type Theme } from '../support/i18n.ts'
import {
  drawerToggle,
  gaps,
  messageMenu,
  moreButton,
  openChannelPhone,
  openDrawer,
  pressAndHold,
  reachable,
  setKeyboard,
  signInPhone,
  visibleArea,
} from '../support/mobile.ts'

type Box = { x: number; y: number; width: number; height: number }

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox()
  if (!found) throw new Error(`${String(locator)} has no box`)
  return found
}

const viewportOf = (page: Page) => page.evaluate(() => ({ width: document.documentElement.clientWidth, height: window.innerHeight }))

/** A room of one's own with a few messages, open on the phone. */
async function roomWithMessages(person: Person, count = 3): Promise<{ id: number; name: string; last: string }> {
  const name = uniq('phone')
  const { id } = await api(person.page).createChannel(name, 'public', 'A topic long enough to be cut on a phone, whatever the language of the reader')
  let last = ''
  for (let i = 1; i <= count; i += 1) {
    last = `message ${i} ${uniq('m')}`
    await api(person.page).postMessage(id, last)
  }
  await person.page.reload()
  await expect(drawerToggle(person.page)).toBeVisible()
  await openChannelPhone(person, name)
  if (last) await expect(ui(person).sent(last)).toHaveCount(1)
  return { id, name, last }
}

test('the page is set up for a phone: viewport, dynamic height, scrolling kept inside', async ({ browser }) => {
  let person: Person | undefined
  try {
    person = await signInPhone(browser, `Viewport ${uniq('v')}`)
    const { page } = person
    expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches), 'the emulated device is a touch screen').toBe(true)

    // The whole screen (notch included, padded by the app), resized for the keyboard on Android, zoom left alone.
    const viewport = (await page.locator('meta[name="viewport"]').getAttribute('content')) ?? ''
    const parts = viewport.split(',').map((part) => part.trim())
    expect(parts).toEqual(expect.arrayContaining(['width=device-width', 'initial-scale=1', 'viewport-fit=cover', 'interactive-widget=resizes-content']))
    expect(viewport).not.toMatch(/user-scalable|maximum-scale/)

    // The app is exactly the visible height, and the page itself never scrolls (its areas do).
    const { height } = await viewportOf(page)
    expect((await box(page.locator('.shell--app'))).height).toBeCloseTo(height, 0)
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

    // A scroll that reaches the end of a list stops there: no pull-to-refresh, no page bounce behind it.
    await expect(page.locator('html')).toHaveCSS('overscroll-behavior-y', 'none')
    await expect(page.locator('.shell__main .message-list')).toHaveCSS('overscroll-behavior-y', 'contain')
    await openDrawer(person)
    await expect(page.locator('.sidebar__scroll')).toHaveCSS('overscroll-behavior-y', 'contain')

    // A double tap on a control is two taps, never a zoom (and no click delay).
    for (const control of [page.locator('.shell__footer').getByRole('button', { name: t('en', 'action.send') }), ui(person).composer, drawerToggle(page)]) {
      await expect(control).toHaveCSS('touch-action', 'manipulation')
    }

    // A tap gets the theme's own feedback, not the browser's grey flash.
    const tapColour = await page.locator('.sidebar .nav-item').first().evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-tap-highlight-color'))
    expect(tapColour).not.toBe('')
    expect(tapColour).not.toMatch(/^rgba\(0, 0, 0, 0\.[0-9]+\)$/)
  } finally {
    await closeAll(person)
  }
})

test('fields are 16 px or larger, so focusing one never zooms the page (iOS)', async ({ browser }) => {
  let person: Person | undefined
  try {
    person = await signInPhone(browser, `Fields ${uniq('f')}`)
    const { page } = person
    const view = ui(person)
    const small: string[] = []
    /** Every visible text field on screen now. */
    const check = async (where: string) => {
      const found = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('input:not([type="hidden"], [type="file"], [type="checkbox"], [type="radio"]), textarea, select')]
          .filter((field) => field.getClientRects().length > 0)
          .map((field) => ({ field: field.className || field.tagName, size: parseFloat(getComputedStyle(field).fontSize) })),
      )
      expect(found.length, `fields in ${where}`).toBeGreaterThan(0)
      for (const { field, size } of found) if (size < 16) small.push(`${where}: ${field} ${size}px`)
    }

    const { last } = await roomWithMessages(person, 1)
    await check('composer')

    // Editing my message.
    const message = view.sent(last)
    await moreButton(person, message).tap()
    await messageMenu(page).getByRole('menuitem', { name: t('en', 'action.edit') }).tap()
    // (While edited, the message's text is the editor's value: found by its place, not its text.)
    const editor = view.log.locator('.message-editor textarea')
    await expect(editor).toBeVisible()
    await check('message editor')
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)

    // The thread's composer.
    await moreButton(person, message).tap()
    await messageMenu(page).getByRole('menuitem', { name: t('en', 'action.reply') }).tap()
    await expect(view.thread).toBeVisible()
    await check('thread')
    await view.thread.getByRole('button', { name: t('en', 'thread.close') }).tap()
    await expect(view.thread).toHaveCount(0)

    // The sidebar's dialogs.
    for (const [action, title] of [
      ['nav.newMessage', 'dm.title'],
      ['nav.browse', 'channel.browse.title'],
      ['nav.newChannel', 'channel.create.title'],
    ] as const) {
      await openDrawer(person)
      await page.getByRole('button', { name: t('en', action) }).tap()
      const dialog = page.getByRole('dialog', { name: t('en', title) })
      await expect(dialog).toBeVisible()
      await check(title)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
    expect(small).toEqual([])
  } finally {
    await closeAll(person)
  }
})

test('the main controls are at least 44 x 44 px, the way to a message’s actions included', async ({ browser }) => {
  let person: Person | undefined
  try {
    person = await signInPhone(browser, `Targets ${uniq('t')}`)
    const { page } = person
    const view = ui(person)
    const { last } = await roomWithMessages(person, 1)
    const tooSmall: string[] = []
    const measure = async (name: string, locator: Locator) => {
      const all = await locator.all()
      expect(all.length, `${name} on screen`).toBeGreaterThan(0)
      for (const element of all) {
        if (!(await element.isVisible())) continue
        const { width, height } = await box(element)
        if (width < 43.5 || height < 43.5) tooSmall.push(`${name}: ${width.toFixed(1)} x ${height.toFixed(1)}`)
      }
    }

    await measure('drawer toggle', drawerToggle(page))
    await measure('channel details', view.header.locator('.channel-header__details'))
    await measure('attach', page.locator('.shell__footer').getByRole('button', { name: t('en', 'composer.attach') }))
    await measure('send', page.locator('.shell__footer').getByRole('button', { name: t('en', 'action.send') }))
    await measure('message actions', moreButton(person, view.sent(last)))

    await moreButton(person, view.sent(last)).tap()
    await measure('menu items', messageMenu(page).getByRole('menuitem'))
    await messageMenu(page).getByRole('menuitem', { name: t('en', 'action.reply') }).tap()
    await expect(view.thread).toBeVisible()
    await measure('thread close', view.thread.getByRole('button', { name: t('en', 'thread.close') }))
    await measure('thread send', view.thread.getByRole('button', { name: t('en', 'action.send') }))
    await measure('thread attach', view.thread.getByRole('button', { name: t('en', 'composer.attach') }))
    await view.thread.getByRole('button', { name: t('en', 'thread.close') }).tap()

    await openDrawer(person)
    await measure('channels', page.locator('.sidebar a.nav-item'))
    await measure('sidebar actions', page.locator('.sidebar .nav-item--action'))
    await measure('account menu', view.userMenu)
    expect(tooSmall).toEqual([])
  } finally {
    await closeAll(person)
  }
})

test('a message’s actions without hovering: a tap on its button, or a long press on it', async ({ browser, browserName }) => {
  let person: Person | undefined
  try {
    person = await signInPhone(browser, `Fingers ${uniq('h')}`)
    const { page, context } = person
    const view = ui(person)
    const { last } = await roomWithMessages(person, 2)
    const message = view.sent(last)
    const body = message.locator('.message__body')

    // The button is there without any hover, and a tap opens the menu.
    await expect(moreButton(person, message)).toBeInViewport({ ratio: 1 })
    await moreButton(person, message).tap()
    await expect(messageMenu(page).getByRole('menuitem', { name: t('en', 'action.reply') })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(messageMenu(page)).toHaveCount(0)

    // A long press on the message opens the same menu, and lifting the finger leaves it open.
    const hold = await pressAndHold(body)
    await expect(messageMenu(page)).toBeVisible()
    await hold.release()
    await expect(messageMenu(page)).toBeVisible()
    // No selection handles or callout of the browser's over the menu: the text is copied from it.
    await expect(body).toHaveCSS('user-select', 'none')
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await messageMenu(page).getByRole('menuitem', { name: t('en', 'action.copy') }).tap()
    await expect(view.toasts).toContainText(t('en', 'message.copied'))
    if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(last)

    // Android's long press fires `contextmenu`: the same menu, and not the browser's own.
    const prevented = await body.evaluate((element) => {
      const at = element.getBoundingClientRect()
      const point = { bubbles: true, cancelable: true, clientX: at.x + 8, clientY: at.y + 8 }
      const touch = { ...point, pointerType: 'touch', pointerId: 12, isPrimary: true }
      element.dispatchEvent(new PointerEvent('pointerdown', touch))
      const event = new MouseEvent('contextmenu', point)
      element.dispatchEvent(event)
      element.dispatchEvent(new PointerEvent('pointercancel', touch))
      return event.defaultPrevented
    })
    expect(prevented).toBe(true)
    await expect(messageMenu(page)).toBeVisible()
  } finally {
    await closeAll(person)
  }
})

test('the composer stays above the on-screen keyboard (emulated visual viewport), as do a thread’s and a dialog', async ({ browser }) => {
  let person: Person | undefined
  try {
    person = await signInPhone(browser, `Keys ${uniq('k')}`, { keyboard: true })
    const { page } = person
    const view = ui(person)
    const { last } = await roomWithMessages(person, 2)
    const send = page.locator('.shell__footer').getByRole('button', { name: t('en', 'action.send') })
    const { height } = await viewportOf(page)
    const inside = async (locator: Locator) => {
      const area = await visibleArea(page)
      const found = await box(locator)
      return found.y >= area.top - 0.5 && found.y + found.height <= area.bottom + 0.5
    }

    /** Fully inside what the keyboard leaves visible, and what a tap there reaches. */
    const expectAboveKeyboard = async (...locators: Locator[]) => {
      for (const locator of locators) {
        await expect.poll(() => inside(locator), { message: `${String(locator)} above the keyboard` }).toBe(true)
        expect(await reachable(locator), `${String(locator)} reachable`).toBe(true)
      }
    }

    await view.composer.tap()
    // iOS: the keyboard (300 px) covers the bottom of the layout viewport, which keeps its height.
    await setKeyboard(page, 300)
    await expectAboveKeyboard(view.composer, send, drawerToggle(page))
    // Safari also pans the page to bring the field up: the app follows what is visible.
    await setKeyboard(page, 300, 120)
    await expectAboveKeyboard(view.composer, send, drawerToggle(page))
    await expect(view.sent(last)).toBeInViewport()

    // Typed and sent with the keyboard up.
    const text = `typed above the keyboard ${uniq('m')}`
    await view.composer.fill(text)
    await send.tap()
    await expect(view.sent(text)).toHaveCount(1)
    await expect.poll(() => inside(view.sent(text))).toBe(true)

    // Closed: the app takes the whole height again.
    await setKeyboard(page, 0)
    await expect.poll(async () => (await box(page.locator('.shell--app'))).height).toBeCloseTo(height, 0)

    // A thread's composer, over the conversation.
    await moreButton(person, view.sent(text)).tap()
    await messageMenu(page).getByRole('menuitem', { name: t('en', 'action.reply') }).tap()
    await expect(view.thread).toBeVisible()
    await view.threadComposer.tap()
    await setKeyboard(page, 320, 80)
    await expectAboveKeyboard(view.threadComposer, view.thread.getByRole('button', { name: t('en', 'action.send') }), view.thread.getByRole('button', { name: t('en', 'thread.close') }))
    await setKeyboard(page, 0)
    await view.thread.getByRole('button', { name: t('en', 'thread.close') }).tap()
    await expect(view.thread).toHaveCount(0)

    // A dialog: all of it, its field and its buttons stay above the keyboard.
    await openDrawer(person)
    await page.getByRole('button', { name: t('en', 'nav.newChannel') }).tap()
    const dialog = page.getByRole('dialog', { name: t('en', 'channel.create.title') })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel(t('en', 'channel.create.name')).tap()
    await setKeyboard(page, 300, 60)
    await expect.poll(() => inside(dialog), { message: 'the dialog above the keyboard' }).toBe(true)
    await expectAboveKeyboard(dialog.getByLabel(t('en', 'channel.create.name')), dialog.getByRole('button', { name: t('en', 'channel.create.submit') }))
  } finally {
    await closeAll(person)
  }
})

const NOTCH = { top: 47, bottom: 34, start: 44, end: 30 }

for (const locale of ['en', 'he'] satisfies Locale[]) {
  test(`the notch and the home indicator stay clear: header, composer, drawer, thread, notices (${locale})`, async ({ browser }) => {
    let person: Person | undefined
    try {
      let realtime: Awaited<ReturnType<typeof realtimeSwitch>> | undefined
      person = await signInPhone(browser, `Notch ${uniq('n')}`, { locale, beforeSignIn: async (page) => void (realtime = await realtimeSwitch(page)) })
      const { page } = person
      const view = ui(person)
      const { last } = await roomWithMessages(person, 1)
      // A notched phone in emulation: what env(safe-area-inset-*) would give, set where the app reads it.
      await page.evaluate((insets) => {
        const style = document.documentElement.style
        style.setProperty('--safe-top', `${insets.top}px`)
        style.setProperty('--safe-bottom', `${insets.bottom}px`)
        style.setProperty('--safe-inline-start', `${insets.start}px`)
        style.setProperty('--safe-inline-end', `${insets.end}px`)
      }, NOTCH)
      const { width, height } = await viewportOf(page)
      const clear = async (name: string, locator: Locator, sides: { top?: boolean; bottom?: boolean; start?: boolean; end?: boolean }) => {
        const found = await box(locator)
        const side = gaps(found, width, locale)
        if (sides.top) expect(found.y, `${name}: under the top inset`).toBeGreaterThanOrEqual(NOTCH.top)
        if (sides.bottom) expect(found.y + found.height, `${name}: above the home indicator`).toBeLessThanOrEqual(height - NOTCH.bottom)
        if (sides.start) expect(side.start, `${name}: clear of the inline-start inset`).toBeGreaterThanOrEqual(NOTCH.start)
        if (sides.end) expect(side.end, `${name}: clear of the inline-end inset`).toBeGreaterThanOrEqual(NOTCH.end)
      }

      await clear('drawer toggle', drawerToggle(page), { top: true, start: true })
      await clear('channel details', view.header.locator('.channel-header__details'), { top: true })
      await clear('composer', page.locator('.shell__footer .composer'), { bottom: true, start: true, end: true })
      await clear('message', view.sent(last).locator('.message__body'), { start: true })
      await clear('message actions', moreButton(person, view.sent(last)), { end: true })

      await openDrawer(person)
      const drawer = page.locator('.shell > .sidebar')
      // The drawer itself opens from the very edge at the inline start (its background under the notch)…
      expect(gaps(await box(drawer), width, locale).start).toBeLessThanOrEqual(0.5)
      // …and its content is clear of it.
      await clear('brand', page.locator('.sidebar__brand'), { top: true, start: true })
      await clear('current channel', page.locator('.sidebar a.nav-item[aria-current="page"]'), { start: true })
      await clear('account menu', view.userMenu, { bottom: true, start: true })
      await page.keyboard.press('Escape')
      await expect(view.nav).toBeHidden()

      await moreButton(person, view.sent(last)).tap()
      await messageMenu(page).getByRole('menuitem', { name: t(locale, 'action.reply') }).tap()
      await expect(view.thread).toBeVisible()
      await clear('thread close', view.thread.getByRole('button', { name: t(locale, 'thread.close') }), { top: true, end: true })
      await clear('thread composer', view.thread.locator('.composer'), { bottom: true, start: true, end: true })
      await view.thread.getByRole('button', { name: t(locale, 'thread.close') }).tap()
      await expect(view.thread).toHaveCount(0)

      // A notice in the top band (the connection lost): the band takes the inset, the header no longer does.
      // (Offline emulation alone does not drop an open WebSocket in Chromium: it is cut too.)
      await person.context.setOffline(true)
      await realtime?.cut()
      const notice = page.locator('.conn-banner')
      await expect(notice).toBeVisible({ timeout: 20_000 })
      await clear('connection notice', notice, { top: true })
      const band = await box(page.locator('.top-bands'))
      const toggle = await box(drawerToggle(page))
      expect(toggle.y, 'the header sits under the band, without the inset a second time').toBeLessThan(band.y + band.height + NOTCH.top)
    } finally {
      await person?.context.setOffline(false)
      await closeAll(person)
    }
  })
}

const PHONE_SIZES = [
  { width: 375, height: 667 },
  { width: 360, height: 740 },
]
const LOOKS: [Locale, Theme][] = [
  ['en', 'console'],
  ['he', 'listing'],
  ['fr', 'listing'],
]

/** Nothing on the page, or in its own scrolling areas, is wider than the screen; no control is cut at an edge. */
async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const problems = await page.evaluate(() => {
    const found: string[] = []
    const width = document.documentElement.clientWidth
    const scrollers = document.querySelectorAll<HTMLElement>('.message-list, .thread__log, .sidebar__scroll, .dialog__body, .shell__main')
    for (const element of [document.documentElement, document.body, ...scrollers]) {
      if (element.scrollWidth <= element.clientWidth + 1) continue
      // Which of its descendants stick out (to fix the right one).
      const frame = element.getBoundingClientRect()
      const culprits = [...element.querySelectorAll<HTMLElement>('*')]
        .filter((child) => {
          const rect = child.getBoundingClientRect()
          return rect.width > 0 && (rect.right > frame.right + 1 || rect.left < frame.left - 1)
        })
        .slice(0, 3)
        .map((child) => `${child.className || child.tagName} "${(child.textContent ?? '').trim().slice(0, 24)}"`)
      found.push(`${element.className || element.tagName} scrolls sideways (${element.scrollWidth} > ${element.clientWidth}): ${culprits.join(', ')}`)
    }
    for (const element of document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [role="menuitem"]')) {
      if (element.closest('[inert]')) continue
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0 || getComputedStyle(element).visibility === 'hidden') continue
      if (rect.left < -1 || rect.right > width + 1) found.push(`${element.className || element.tagName} "${(element.textContent ?? '').trim().slice(0, 20)}" cut at ${rect.left.toFixed(0)}..${rect.right.toFixed(0)}`)
    }
    return found
  })
  expect(problems, where).toEqual([])
}

for (const [locale, theme] of LOOKS) {
  test(`no sideways scroll at 375 and 360 px, and the drawer opens from the inline start (${locale}, ${theme})`, async ({ browser }) => {
    let person: Person | undefined
    try {
      person = await signInPhone(browser, locale === 'he' ? 'נועה' : `Narrow ${uniq('w')}`, { locale, theme })
      const { page } = person
      const view = ui(person)
      // A room with the longest name the server allows (40 characters): its label is cut with an
      // ellipsis in the drawer, never widening it.
      const longest = `${uniq('l')}-`.padEnd(40, 'x')
      await api(page).createChannel(longest, 'public')
      const { id } = await roomWithMessages(person, 1)
      // Long words and a long link: they wrap, never push the page wider.
      await api(page).postMessage(id, `${'Antidisestablishmentarianism'.repeat(3)} https://example.test/${'a-very-long-path-segment/'.repeat(6)}?q=1`)
      await api(page).postMessage(id, 'שלום @everyone, מה שלומכם? English inside Hebrew, and #general.')
      const long = view.sent('Antidisestablishmentarianism')
      await expect(long).toHaveCount(1)
      for (const size of PHONE_SIZES) {
        await page.setViewportSize(size)
        await expect.poll(() => page.evaluate(() => document.documentElement.clientWidth)).toBe(size.width)
        await expectNoSidewaysScroll(page, `${size.width}: channel`)

        await openDrawer(person)
        const side = gaps(await box(page.locator('.shell > .sidebar')), size.width, locale)
        expect(side.start, 'the drawer is at the inline start (the right in Hebrew)').toBeLessThanOrEqual(0.5)
        expect(side.end, 'and leaves some of the conversation visible').toBeGreaterThan(20)
        await expectNoSidewaysScroll(page, `${size.width}: drawer`)
        const label = view.navItem(longest).locator('.nav-item__label')
        await label.scrollIntoViewIfNeeded()
        expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth), 'the longest name is cut (ellipsis)').toBe(true)
        await expect(label).toHaveCSS('text-overflow', 'ellipsis')
        await expect(view.navItem(longest)).toBeInViewport({ ratio: 1 })
        // Closed with a tap on what it leaves visible (no swipe needed).
        await page.touchscreen.tap(locale === 'he' ? 8 : size.width - 8, size.height / 2)
        await expect(view.nav).toBeHidden()

        await moreButton(person, long).tap()
        await expect(messageMenu(page)).toBeVisible()
        await expectNoSidewaysScroll(page, `${size.width}: menu`)
        await messageMenu(page).getByRole('menuitem', { name: t(locale, 'action.reply') }).tap()
        await expect(view.thread).toBeVisible()
        await expectNoSidewaysScroll(page, `${size.width}: thread`)
        await view.thread.getByRole('button', { name: t(locale, 'thread.close') }).tap()
        await expect(view.thread).toHaveCount(0)
      }
    } finally {
      await closeAll(person)
    }
  })
}

test('dialogs fit the screen and scroll inside, not the page behind them', async ({ browser }) => {
  let person: Person | undefined
  try {
    person = await signInPhone(browser, `Dialogs ${uniq('d')}`)
    const { page } = person
    // Enough public channels to overflow the browse dialog on a phone.
    const prefix = uniq('many')
    for (let i = 0; i < 14; i += 1) await api(page).createChannel(`${prefix}-${i.toString().padStart(2, '0')}`, 'public', 'one of many')
    await page.setViewportSize({ width: 360, height: 640 })
    await openDrawer(person)
    await page.getByRole('button', { name: t('en', 'nav.browse') }).tap()
    const dialog = page.getByRole('dialog', { name: t('en', 'channel.browse.title') })
    await dialog.getByLabel(t('en', 'channel.browse.filter')).fill(prefix)
    await expect(dialog.locator('.browse__item')).toHaveCount(14)
    await expect(dialog).toBeInViewport({ ratio: 1 })
    const body = dialog.locator('.dialog__body')
    expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight), 'the list overflows its dialog').toBe(true)
    await expect(body).toHaveCSS('overflow-y', 'auto')
    await expect(body).toHaveCSS('overscroll-behavior-y', 'contain')
    // Scrolled to its last channel: the dialog's own area moved, the page did not.
    await dialog.locator('.browse__item').last().scrollIntoViewIfNeeded()
    expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual([0, 0])
    await expect(dialog.locator('.dialog__header')).toBeInViewport({ ratio: 1 })
    await expectNoSidewaysScroll(page, 'browse dialog')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // A form with its buttons, on a short screen: the buttons stay in view, the body scrolls.
    await page.setViewportSize({ width: 360, height: 420 })
    await openDrawer(person)
    await page.getByRole('button', { name: t('en', 'nav.newChannel') }).tap()
    const create = page.getByRole('dialog', { name: t('en', 'channel.create.title') })
    await expect(create).toBeInViewport({ ratio: 1 })
    await expect(create.getByRole('button', { name: t('en', 'channel.create.submit') })).toBeInViewport({ ratio: 1 })
    await expect(create.getByLabel(t('en', 'channel.create.name'))).toBeInViewport({ ratio: 1 })
    expect(await create.locator('.dialog__body').evaluate((element) => element.scrollHeight > element.clientHeight), 'its body scrolls').toBe(true)
  } finally {
    await closeAll(person)
  }
})

/** Names in the page's own script. */
const names: Record<Locale, string> = { en: 'Ada', he: 'נועה', fr: 'Aurélie' }

for (const locale of ['en', 'he'] satisfies Locale[]) {
  test(`the core journey by touch: sign in, post, reply in a thread, react, write privately (${locale})`, async ({ browser }, testInfo) => {
    // English on both phones; Hebrew (right to left) on the iPhone only, to keep the run short.
    test.skip(locale === 'he' && testInfo.project.name !== 'iphone', 'Hebrew runs on the iPhone project')
    let me: Person | undefined
    let peer: Person | undefined
    try {
      peer = await signInPhone(browser, `Peer ${uniq('p')}`)
      me = await signInPhone(browser, names[locale], { locale })
      const { page } = me
      const view = ui(me)
      // Signed in, on a channel (which one depends on the rooms the parallel tests created: a new member
      // lands in the first room by name), with #general in the drawer.
      await expect(view.header.locator('.channel-header__name')).toHaveText(/^#/)
      await expect(view.composer).toBeVisible()
      await expect(view.navItem('general')).toHaveCount(1)

      // Post, with the Send button, in a room of one's own (#general is busy with the parallel tests).
      const room = await roomWithMessages(me, 0)
      const hello = `hello from a phone ${uniq('m')}`
      await view.composer.tap()
      await view.composer.fill(hello)
      await page.locator('.shell__footer').getByRole('button', { name: t(locale, 'action.send') }).tap()
      await expect(view.sent(hello)).toHaveCount(1)

      // Reply in its thread, from the message's menu.
      const message = view.sent(hello)
      await moreButton(me, message).tap()
      await messageMenu(page).getByRole('menuitem', { name: t(locale, 'action.reply') }).tap()
      await expect(page).toHaveURL(new RegExp(`/c/${room.id}/t/\\d+$`))
      const answer = `thread reply ${uniq('r')}`
      await view.threadComposer.tap()
      await view.threadComposer.fill(answer)
      await view.thread.getByRole('button', { name: t(locale, 'action.send') }).tap()
      await expect(view.reply(answer)).toHaveCount(1)
      await view.thread.getByRole('button', { name: t(locale, 'thread.close') }).tap()
      await expect(view.thread).toHaveCount(0)
      await expect(message.locator('.thread-link')).toContainText(plural(locale, 'message.replies', 1))

      // React, after a long press.
      const hold = await pressAndHold(message.locator('.message__body'))
      await expect(messageMenu(page)).toBeVisible()
      await hold.release()
      await messageMenu(page).getByRole('menuitem', { name: t(locale, 'action.react') }).tap()
      const firstEmoji = page.locator('.popover--placed .emoji-picker .emoji-picker__item').first()
      const emoji = (await firstEmoji.textContent()) ?? ''
      await firstEmoji.tap()
      await expect(message.getByRole('button', { name: plural(locale, 'reaction.label', 1, { emoji }) })).toHaveAttribute('aria-pressed', 'true')

      // A conversation with the other person, from the drawer.
      await openDrawer(me)
      await page.getByRole('button', { name: t(locale, 'nav.newMessage') }).tap()
      const dialog = page.getByRole('dialog', { name: t(locale, 'dm.title') })
      await dialog.getByRole('combobox').fill(peer.name)
      await dialog.getByRole('option', { name: peer.name }).tap()
      await dialog.getByRole('button', { name: t(locale, 'dm.start') }).tap()
      await expect(view.header.locator('.channel-header__name')).toHaveText(isolated(peer.name))
      await expect(view.nav).toBeHidden()
      const secret = `a word in private ${uniq('dm')}`
      await view.composer.fill(secret)
      await page.locator('.shell__footer').getByRole('button', { name: t(locale, 'action.send') }).tap()
      await expect(view.sent(secret)).toHaveCount(1)
    } finally {
      await closeAll(me, peer)
    }
  })
}
