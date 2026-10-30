import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetClientState } from './api/client.ts'
import { LAST_CHANNEL_KEY } from './lib/prefs.ts'
import { boot, endSession } from './session.ts'
import { session } from './store/session.ts'
import { fakeFetch } from './test/fakes.ts'

afterEach(() => {
  localStorage.clear()
  session.value = { status: 'loading' }
  vi.unstubAllGlobals()
})

describe('endSession', () => {
  it.each([null, 'session_expired', 'banned'])(
    'forgets the last open channel (%s): the next person on a shared device does not land in it',
    (reason) => {
      localStorage.setItem(LAST_CHANNEL_KEY, '42')
      localStorage.setItem('slax.locale', 'he')
      localStorage.setItem('slax.theme', 'listing')
      endSession(reason)
      expect(localStorage.getItem(LAST_CHANNEL_KEY)).toBeNull()
      // The device's language and theme are not private: they stay.
      expect(localStorage.getItem('slax.locale')).toBe('he')
      expect(localStorage.getItem('slax.theme')).toBe('listing')
    },
  )
})

describe('boot', () => {
  it.each([
    ['no session (signed out, or expired while the app was closed)', 401, { message: 'Unauthenticated.' }, 'signed-out'],
    ['a banned account', 403, { error: 'account_banned' }, 'signed-out'],
  ])('forgets the last open channel at start-up with %s', async (_, status, body, expected) => {
    resetClientState()
    localStorage.setItem(LAST_CHANNEL_KEY, '42')
    localStorage.setItem('slax.locale', 'fr')
    vi.stubGlobal('fetch', fakeFetch({ 'GET /api/v1/me': () => ({ status, body }) }).fetch)
    await boot()
    expect(session.value.status).toBe(expected)
    expect(localStorage.getItem(LAST_CHANNEL_KEY)).toBeNull()
    expect(localStorage.getItem('slax.locale')).toBe('fr')
  })

  it('keeps it when the server cannot be reached (the session may well be alive)', async () => {
    resetClientState()
    localStorage.setItem(LAST_CHANNEL_KEY, '42')
    vi.stubGlobal('fetch', fakeFetch({ 'GET /api/v1/me': () => 'network-error' }).fetch)
    await boot()
    expect(session.value.status).toBe('unreachable')
    expect(localStorage.getItem(LAST_CHANNEL_KEY)).toBe('42')
  })
})
