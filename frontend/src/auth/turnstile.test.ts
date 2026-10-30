import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOAD_TIMEOUT_MS, TOKEN_TIMEOUT_MS, TurnstileError } from './turnstile.ts'

type Options = Record<string, (...args: unknown[]) => void>

async function freshModule() {
  vi.resetModules()
  return import('./turnstile.ts')
}

beforeEach(() => vi.useFakeTimers())

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete window.turnstile
  document.head.querySelectorAll('script').forEach((s) => s.remove())
})

const options = { locale: 'en', theme: 'console' } as const

describe('Turnstile client', () => {
  it('gives up as "unavailable" when the script does not load in time, and loads again on the next try', async () => {
    // The script element is kept out of the document: it neither loads nor fails, it hangs.
    const appended: HTMLScriptElement[] = []
    vi.spyOn(document.head, 'append').mockImplementation((...nodes) => void appended.push(...(nodes as HTMLScriptElement[])))
    const { cloudflareTurnstile } = await freshModule()
    let outcome: string | null = null
    void cloudflareTurnstile.token(document.createElement('div'), options).then(
      () => (outcome = 'token'),
      (e: TurnstileError) => (outcome = e.reason),
    )
    expect(appended.map((s) => s.src)).toEqual(['https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'])
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1)
    expect(outcome).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toBe('unavailable')

    void cloudflareTurnstile.token(document.createElement('div'), options).catch(() => undefined)
    expect(appended).toHaveLength(2)
  })

  it('gives up as "unavailable" when the widget never answers, but not while a challenge waits for the person', async () => {
    let widget: Options = {}
    const remove = vi.fn()
    window.turnstile = { render: (_: HTMLElement, o: Record<string, unknown>) => ((widget = o as Options), 'w1'), remove }
    const { cloudflareTurnstile } = await freshModule()

    const silent = cloudflareTurnstile.token(document.createElement('div'), options).then(() => 'token', (e: TurnstileError) => e.reason)
    await vi.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS)
    expect(await silent).toBe('unavailable')
    await vi.advanceTimersByTimeAsync(1)
    expect(remove).toHaveBeenCalledWith('w1')

    const interactive = cloudflareTurnstile.token(document.createElement('div'), options)
    await vi.advanceTimersByTimeAsync(0) // rendered
    widget['before-interactive-callback']()
    await vi.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS * 3)
    widget['after-interactive-callback']()
    widget.callback('the-token')
    expect(await interactive).toBe('the-token')
  })

  it("uses the deployment's site key from the page, else the build's (Cloudflare's test key in development)", async () => {
    const sitekeys: unknown[] = []
    window.turnstile = { render: (_: HTMLElement, o: Record<string, unknown>) => (sitekeys.push(o.sitekey), 'w1'), remove: vi.fn() }
    const { cloudflareTurnstile } = await freshModule()

    void cloudflareTurnstile.token(document.createElement('div'), options).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0) // rendered
    const tag = document.createElement('meta')
    tag.name = 'slax:turnstile-site-key'
    tag.content = '0x4AAAAAAA-deployed'
    document.head.append(tag)
    void cloudflareTurnstile.token(document.createElement('div'), options).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    tag.remove()

    expect(sitekeys).toEqual([import.meta.env.VITE_TURNSTILE_SITE_KEY || '1x00000000000000000000AA', '0x4AAAAAAA-deployed'])
  })
})
