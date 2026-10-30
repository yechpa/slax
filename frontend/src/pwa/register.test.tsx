import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale, t } from '../i18n/index.ts'
import { flush } from '../test/fakes.ts'
import { applyUpdate, registerServiceWorker, resetServiceWorker, updateReady } from './register.ts'
import { UpdateBanner } from './UpdateBanner.tsx'

/** A service worker as the page sees it: a state, and messages it was sent. */
class FakeWorker extends EventTarget {
  state: ServiceWorkerState
  readonly postMessage = vi.fn()
  constructor(state: ServiceWorkerState) {
    super()
    this.state = state
  }
  become(state: ServiceWorkerState) {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null
  waiting: FakeWorker | null = null
  active: FakeWorker | null = null
  readonly update = vi.fn(async () => undefined)
  /** A new version is found and installs (then waits, as sw.ts never skips waiting by itself). */
  async newVersion(container: FakeContainer) {
    const worker = new FakeWorker('installing')
    this.installing = worker
    this.dispatchEvent(new Event('updatefound'))
    this.installing = null
    this.waiting = worker
    worker.become('installed')
    container.waitingWorker = worker
    return worker
  }
}

/** navigator.serviceWorker: who controls the page, register(), controllerchange. */
class FakeContainer extends EventTarget {
  controller: FakeWorker | null
  waitingWorker: FakeWorker | null = null
  readonly registration = new FakeRegistration()
  readonly register = vi.fn(async () => this.registration as unknown as ServiceWorkerRegistration)
  constructor(controlled: boolean) {
    super()
    this.controller = controlled ? new FakeWorker('activated') : null
    this.registration.active = this.controller
  }
  /** The waiting worker takes over (after SKIP_WAITING, or another tab's). */
  takeOver(worker: FakeWorker) {
    this.registration.waiting = null
    this.registration.active = worker
    this.controller = worker
    worker.become('activated')
    this.dispatchEvent(new Event('controllerchange'))
  }
}

let reload: ReturnType<typeof vi.fn<() => void>>

async function start(container: FakeContainer, enabled = true) {
  return registerServiceWorker({
    enabled,
    container: container as unknown as ServiceWorkerContainer,
    reload,
    checkEveryMs: 60_000,
  })
}

beforeEach(() => {
  setLocale('en')
  reload = vi.fn<() => void>()
})

afterEach(() => {
  resetServiceWorker()
  vi.useRealTimers()
})

describe('registerServiceWorker', () => {
  it('registers /sw.js for the whole site, always revalidating the script', async () => {
    const container = new FakeContainer(false)
    expect(await start(container)).toBe(container.registration)
    expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' })
  })

  it('does nothing in development builds (Vite dev, tests, the design-system build)', async () => {
    const container = new FakeContainer(false)
    expect(await start(container, false)).toBeNull()
    expect(container.register).not.toHaveBeenCalled()
  })

  it('does nothing where service workers are unavailable (old browser, private mode, insecure origin)', async () => {
    expect(await registerServiceWorker({ enabled: true, container: undefined, reload })).toBeNull()
  })

  it('survives a refused registration (the app works without it)', async () => {
    const container = new FakeContainer(false)
    container.register.mockRejectedValueOnce(new DOMException('refused', 'SecurityError'))
    expect(await start(container)).toBeNull()
    expect(updateReady.value).toBe(false)
  })

  it('a first install is not an update: no banner, no reload when it takes the page', async () => {
    const container = new FakeContainer(false)
    await start(container)
    const worker = await container.registration.newVersion(container)
    expect(updateReady.value).toBe(false)
    container.takeOver(worker)
    expect(updateReady.value).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('a new version installed while the page is controlled: the update is offered', async () => {
    const container = new FakeContainer(true)
    await start(container)
    expect(updateReady.value).toBe(false)
    await container.registration.newVersion(container)
    expect(updateReady.value).toBe(true)
  })

  it('a version already waiting at start-up is offered at once', async () => {
    const container = new FakeContainer(true)
    container.registration.waiting = new FakeWorker('installed')
    await start(container)
    expect(updateReady.value).toBe(true)
  })

  it('accepting it tells the waiting worker to take over, then reloads once it has', async () => {
    const container = new FakeContainer(true)
    await start(container)
    const worker = await container.registration.newVersion(container)
    applyUpdate()
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(reload).not.toHaveBeenCalled()
    container.takeOver(worker)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads anyway if the worker never takes over (a reload fetches the newest page in any case)', async () => {
    vi.useFakeTimers()
    const container = new FakeContainer(true)
    await start(container)
    await container.registration.newVersion(container)
    applyUpdate()
    vi.advanceTimersByTime(5_000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('another tab took the update: this one keeps offering a reload (it still runs the old files)', async () => {
    const container = new FakeContainer(true)
    await start(container)
    const worker = await container.registration.newVersion(container)
    container.takeOver(worker)
    expect(reload).not.toHaveBeenCalled()
    expect(updateReady.value).toBe(true)
    applyUpdate()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('checks for a new version when the app comes back to the foreground, and periodically', async () => {
    vi.useFakeTimers()
    const container = new FakeContainer(true)
    await start(container)
    expect(container.registration.update).not.toHaveBeenCalled()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(container.registration.update).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(container.registration.update).toHaveBeenCalledTimes(2)
  })

  it('a failed update check (offline) is ignored', async () => {
    vi.useFakeTimers()
    const container = new FakeContainer(true)
    container.registration.update.mockRejectedValue(new TypeError('Failed to fetch'))
    await start(container)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(container.registration.update).toHaveBeenCalledTimes(1)
    expect(updateReady.value).toBe(false)
  })
})

describe('UpdateBanner', () => {
  let host: HTMLElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
  })
  afterEach(() => {
    render(null, host)
    host.remove()
  })

  it('shows nothing while there is no update', () => {
    render(<UpdateBanner />, host)
    expect(host.textContent).toBe('')
  })

  it('says a new version is ready, in the reader’s language, and reloads on request', async () => {
    const container = new FakeContainer(true)
    await start(container)
    const worker = await container.registration.newVersion(container)
    setLocale('he')
    render(<UpdateBanner />, host)
    await flush()
    const banner = host.querySelector('[role="status"]')!
    expect(banner.textContent).toContain(t('pwa.update.ready'))
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === t('pwa.update.reload'))!
    button.click()
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    container.takeOver(worker)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
