/**
 * Phone steps for mobile.spec.ts (the `iphone` and `pixel` projects): signing in where the channel
 * list is a drawer, tapping instead of hovering, a long press, and an emulated on-screen keyboard.
 */
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { api, newContext, signInThroughGoogle, ui, uniq, type Person } from './app.ts'
import { dirOf, t, type Locale, type Theme } from './i18n.ts'

/** A new person, signed in on a phone (the project's device), on their first channel. */
export async function signInPhone(
  browser: Browser,
  name: string,
  { locale = 'en', theme = 'console', keyboard = false, beforeSignIn }: { locale?: Locale; theme?: Theme; keyboard?: boolean; beforeSignIn?: (page: Page) => Promise<void> } = {},
): Promise<Person> {
  const context = await newContext(browser, { locale, theme })
  if (keyboard) await emulateKeyboard(context)
  const page = await context.newPage()
  await beforeSignIn?.(page)
  const email = `${uniq('phone')}@example.test`
  await signInThroughGoogle(page, { email, name, locale })
  await expect(page.locator('.shell__main .message-list')).toBeVisible()
  await expect(drawerToggle(page)).toBeVisible()
  const me = await api(page).get<{ id: number }>('/me')
  return { context, page, id: me.id, name, email, locale, theme }
}

export const drawerToggle = (page: Page) => page.locator('.shell__main .channel-header__nav')

/** Opens the channel list (a drawer on a phone) with a tap. */
export async function openDrawer(person: Person): Promise<void> {
  await drawerToggle(person.page).tap()
  await expect(ui(person).nav).toBeVisible()
}

/** Opens a channel from the drawer, which closes on the way. */
export async function openChannelPhone(person: Person, label: string): Promise<void> {
  const view = ui(person)
  await openDrawer(person)
  await view.navItem(label).tap()
  await expect(view.header.locator('.channel-header__name')).toContainText(label)
  await expect(view.nav).toBeHidden()
  await expect(view.log).toHaveAttribute('aria-busy', 'false')
}

/** The "more" button of a message: the way to its actions without a mouse. */
export const moreButton = (person: Person, message: Locator) => message.getByRole('button', { name: t(person.locale, 'message.more'), exact: true })

/** The open message menu. */
export const messageMenu = (page: Page) => page.locator('.popover--placed [role="menu"]')

/**
 * A finger held on `target` (pointer events as a touch screen sends them): the app's own timer
 * decides it is a long press, so the caller waits for its effect before `release()`.
 */
export async function pressAndHold(target: Locator) {
  const box = await target.boundingBox()
  if (!box) throw new Error(`${String(target)} is not on screen`)
  const init = { pointerType: 'touch', pointerId: 11, isPrimary: true, bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: box.x + Math.min(24, box.width / 2), clientY: box.y + box.height / 2 }
  await target.dispatchEvent('pointerdown', init)
  return { release: () => target.dispatchEvent('pointerup', { ...init, buttons: 0 }) }
}

/** Distance from the inline start / end of the screen (the right edge in Hebrew). */
export function gaps(box: { x: number; width: number }, width: number, locale: Locale) {
  const left = box.x
  const right = width - (box.x + box.width)
  return dirOf(locale) === 'rtl' ? { start: right, end: left } : { start: left, end: right }
}

/**
 * The on-screen keyboard, emulated (no browser here has one): `window.visualViewport` is replaced,
 * before the app loads, by one whose height shrinks by the keyboard's, the layout viewport staying
 * as it is (iOS Safari; Chrome on Android does the same unless the page asks to be resized), and
 * whose `offsetTop` can move as when Safari pans the page to show the focused field.
 * `window.slaxKeyboard(height, pan)` opens, moves or (0) closes it.
 */
export async function emulateKeyboard(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const real = window.visualViewport
    if (!real) return
    let keyboard = 0
    let pan = 0
    class EmulatedViewport extends EventTarget {
      get width() {
        return real!.width
      }
      get height() {
        return Math.max(0, real!.height - keyboard)
      }
      get offsetLeft() {
        return real!.offsetLeft
      }
      get offsetTop() {
        return real!.offsetTop + pan
      }
      get pageLeft() {
        return real!.pageLeft
      }
      get pageTop() {
        return real!.pageTop + pan
      }
      get scale() {
        return real!.scale
      }
    }
    const viewport = new EmulatedViewport()
    for (const type of ['resize', 'scroll']) real.addEventListener(type, () => viewport.dispatchEvent(new Event(type)))
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => viewport })
    Object.defineProperty(window, 'slaxKeyboard', {
      value: (height: number, offset = 0) => {
        keyboard = height
        pan = offset
        viewport.dispatchEvent(new Event('resize'))
        viewport.dispatchEvent(new Event('scroll'))
      },
    })
  })
}

export const setKeyboard = (page: Page, height: number, pan = 0) =>
  page.evaluate(([h, p]) => (window as unknown as { slaxKeyboard: (height: number, pan: number) => void }).slaxKeyboard(h, p), [height, pan] as const)

/** What can be seen above the keyboard: the visual viewport, in the page's (layout) coordinates. */
export const visibleArea = (page: Page) =>
  page.evaluate(() => {
    const viewport = window.visualViewport!
    return { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height, height: viewport.height }
  })

/** The element is what a tap at its centre reaches (nothing drawn over it). */
export const reachable = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return top !== null && (top === element || element.contains(top))
  })
