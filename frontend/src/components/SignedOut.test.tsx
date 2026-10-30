import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientState } from '../api/client.ts'
import { TurnstileError, type TurnstileClient } from '../auth/turnstile.ts'
import { setLocale } from '../i18n/index.ts'
import { fakeFetch, flush } from '../test/fakes.ts'
import { SignedOut } from './SignedOut.tsx'

let host: HTMLElement
const fakeTurnstile = (result: string | Error): TurnstileClient => ({
  token: vi.fn(async () => {
    if (result instanceof Error) throw result
    return result
  }),
})

beforeEach(() => {
  resetClientState()
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  render(null, host)
  host.remove()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
  setLocale('en')
})

describe('signed-out screen', () => {
  it('signed_out_screen_shows_translated_auth_error_and_clears_url', () => {
    setLocale('fr')
    history.replaceState(null, '', '/?auth_error=email_unverified&keep=1#top')
    render(<SignedOut turnstile={fakeTurnstile('t')} />, host)

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Votre adresse e-mail Google n'est pas vérifiée : elle ne peut pas servir ici.",
    )
    // Removed from the address bar, the rest kept, without adding a history entry.
    expect(location.search).toBe('?keep=1')
    expect(location.hash).toBe('#top')

    // Unknown codes still say something useful; Hebrew too.
    render(null, host)
    setLocale('he')
    history.replaceState(null, '', '/?auth_error=%3Cscript%3E')
    render(<SignedOut turnstile={fakeTurnstile('t')} />, host)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('ההתחברות נכשלה. כדאי לנסות שוב.')
    expect(location.search).toBe('')
  })

  it('runs Turnstile, then starts Google sign-in with the token and leaves for Google', async () => {
    const server = fakeFetch({
      'POST /api/v1/auth/google/start': () => ({ body: { redirect_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' } }),
    })
    vi.stubGlobal('fetch', server.fetch)
    const goTo = vi.fn()
    const turnstile = fakeTurnstile('turnstile-token')
    render(<SignedOut turnstile={turnstile} goTo={goTo} />, host)

    const button = host.querySelector<HTMLButtonElement>('.signin__google')!
    expect(button.textContent).toBe('Continue with Google')
    button.click()
    await flush()
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('Connecting to Google…')

    expect(turnstile.token).toHaveBeenCalledOnce()
    const start = server.calls.find((c) => c.path === '/api/v1/auth/google/start')!
    expect(start.body).toEqual({ turnstile_token: 'turnstile-token' })
    expect(start.headers['X-XSRF-TOKEN']).toBe('test+token')
    expect(goTo).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=s')
  })

  it('explains a failed check and lets the person try again', async () => {
    const server = fakeFetch({
      'POST /api/v1/auth/google/start': () => ({ status: 422, body: { error: 'turnstile_failed' } }),
    })
    vi.stubGlobal('fetch', server.fetch)
    const goTo = vi.fn()
    render(<SignedOut turnstile={fakeTurnstile('t')} goTo={goTo} />, host)
    host.querySelector<HTMLButtonElement>('.signin__google')!.click()
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The anti-bot check did not pass. Please try again.')
    expect(host.querySelector<HTMLButtonElement>('.signin__google')!.disabled).toBe(false)
    expect(goTo).not.toHaveBeenCalled()

    render(<SignedOut turnstile={fakeTurnstile(new TurnstileError('unavailable'))} goTo={goTo} />, host)
    host.querySelector<HTMLButtonElement>('.signin__google')!.click()
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The anti-bot check did not pass. Please try again.')
  })

  it('never follows a redirect that is not a web address', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'POST /api/v1/auth/google/start': () => ({ body: { redirect_url: 'javascript:alert(1)' } }) }).fetch)
    const goTo = vi.fn()
    render(<SignedOut turnstile={fakeTurnstile('t')} goTo={goTo} />, host)
    host.querySelector<HTMLButtonElement>('.signin__google')!.click()
    await flush()
    expect(goTo).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Sign-in failed. Please try again.')
  })
})
