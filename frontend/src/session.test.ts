import { afterEach, describe, expect, it } from 'vitest'
import { LAST_CHANNEL_KEY } from './lib/prefs.ts'
import { endSession } from './session.ts'
import { session } from './store/session.ts'

afterEach(() => {
  localStorage.clear()
  session.value = { status: 'loading' }
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
