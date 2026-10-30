import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale, t, type Locale } from '../i18n/index.ts'
import { flush } from '../test/fakes.ts'
import { InstallPrompt } from './InstallPrompt.tsx'
import { install, installPrompt, installVariant, isIos, isStandalone, listenForInstall, type BeforeInstallPromptEvent } from './install.ts'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP_MODE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15'
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'

function fakeNavigator(userAgent: string, { platform = '', maxTouchPoints = 0, standalone }: { platform?: string; maxTouchPoints?: number; standalone?: boolean } = {}) {
  vi.stubGlobal('navigator', { ...navigator, userAgent, platform, maxTouchPoints, standalone, languages: ['en'] })
}

function fakeDisplayMode(standalone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: query === '(display-mode: standalone)' ? standalone : false,
    addEventListener() {},
    removeEventListener() {},
  }))
}

/** Chromium's beforeinstallprompt: prompt() shows the browser's own install dialog. */
function promptEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent
  Object.assign(event, { prompt: vi.fn(async () => undefined), userChoice: Promise.resolve({ outcome, platform: 'web' }) })
  return event
}

let host: HTMLElement
let stop: () => void

beforeEach(() => {
  setLocale('en')
  fakeDisplayMode(false)
  fakeNavigator(ANDROID_CHROME)
  host = document.createElement('div')
  document.body.append(host)
  stop = listenForInstall(window)
})

afterEach(() => {
  render(null, host)
  host.remove()
  stop()
  installPrompt.value = null
  vi.unstubAllGlobals()
})

describe('installVariant', () => {
  it('shows nothing once installed (opened from the home screen, standalone)', () => {
    expect(installVariant({ standalone: true, ios: true, canPrompt: false })).toBe('none')
    expect(installVariant({ standalone: true, ios: false, canPrompt: true })).toBe('none')
  })

  it("offers the browser's install where it can prompt (Chromium: Android, desktop)", () => {
    expect(installVariant({ standalone: false, ios: false, canPrompt: true })).toBe('prompt')
  })

  it('explains Add to Home Screen on iOS (no install prompt there)', () => {
    expect(installVariant({ standalone: false, ios: true, canPrompt: false })).toBe('ios')
  })

  it('says nothing where it can do nothing (Firefox desktop, or Chromium before it allows installing)', () => {
    expect(installVariant({ standalone: false, ios: false, canPrompt: false })).toBe('none')
  })
})

describe('platform detection', () => {
  it('recognises iPhone and iPad, including an iPad asking for desktop sites', () => {
    fakeNavigator(IPHONE)
    expect(isIos()).toBe(true)
    fakeNavigator(IPAD_DESKTOP_MODE, { platform: 'MacIntel', maxTouchPoints: 5 })
    expect(isIos()).toBe(true)
    fakeNavigator(IPAD_DESKTOP_MODE, { platform: 'MacIntel', maxTouchPoints: 0 })
    expect(isIos()).toBe(false)
    fakeNavigator(ANDROID_CHROME)
    expect(isIos()).toBe(false)
  })

  it('knows when it runs installed: display-mode standalone, or iOS’s navigator.standalone', () => {
    expect(isStandalone()).toBe(false)
    fakeDisplayMode(true)
    expect(isStandalone()).toBe(true)
    fakeDisplayMode(false)
    fakeNavigator(IPHONE, { standalone: true })
    expect(isStandalone()).toBe(true)
  })
})

describe('InstallPrompt', () => {
  it('Chromium: keeps the install event for later (no mini-infobar) and offers an Install button', async () => {
    render(<InstallPrompt />, host)
    expect(host.textContent).toBe('')
    const event = promptEvent()
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === t('pwa.install.action'))!
    expect(host.textContent).toContain(t('pwa.install.hint'))
    button.click()
    expect(event.prompt).toHaveBeenCalledTimes(1)
    await flush()
    // The event can be used once: the button goes until the browser offers it again.
    expect(host.querySelector('button')).toBeNull()
  })

  it("a refused prompt (the browser's own rules, a second call) is not an error, and the event stays spent", async () => {
    const event = promptEvent()
    vi.mocked(event.prompt).mockRejectedValueOnce(new DOMException('already shown', 'InvalidStateError'))
    window.dispatchEvent(event)
    await expect(install()).resolves.toBeUndefined()
    expect(installPrompt.value).toBeNull()
  })

  it('Chromium: the offer goes once the app is installed', async () => {
    render(<InstallPrompt />, host)
    window.dispatchEvent(promptEvent())
    await flush()
    expect(host.querySelector('button')).not.toBeNull()
    window.dispatchEvent(new Event('appinstalled'))
    await flush()
    expect(host.textContent).toBe('')
  })

  it.each<Locale>(['en', 'he', 'fr'])('iOS Safari: step-by-step Add to Home Screen help, in %s', (locale) => {
    setLocale(locale)
    fakeNavigator(IPHONE)
    render(<InstallPrompt />, host)
    const steps = [...host.querySelectorAll('ol li')].map((li) => li.textContent)
    expect(steps).toEqual([t('pwa.install.ios.step1'), t('pwa.install.ios.step2'), t('pwa.install.ios.step3')])
    expect(host.textContent).toContain(t('pwa.install.ios.title'))
    expect(host.querySelector('button')).toBeNull()
  })

  it('installed (standalone): nothing at all, on iOS or with a pending prompt', async () => {
    fakeDisplayMode(true)
    render(<InstallPrompt />, host)
    window.dispatchEvent(promptEvent())
    await flush()
    expect(host.innerHTML).toBe('')
    fakeNavigator(IPHONE, { standalone: true })
    fakeDisplayMode(false)
    render(<InstallPrompt key="again" />, host)
    expect(host.innerHTML).toBe('')
  })
})
