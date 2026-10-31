/**
 * Start-up and the session's life: who is signed in (GET /me), what the account says
 * about language and theme, and how a session ends (sign-out, expiry, ban).
 */
import { batch } from '@preact/signals'
import { holdRequests, isApiError, onClientEvent, releaseRequests } from './api/client.ts'
import { api } from './api/endpoints.ts'
import type { Me } from './api/types.ts'
import { isLocale, plural, setLocale, t } from './i18n/index.ts'
import { LAST_CHANNEL_KEY, readPref, removePref } from './lib/prefs.ts'
import { clearAppCaches } from './pwa/caches.ts'
import { dropPushLocally, forgetPushOnSignOut } from './pwa/push.ts'
import { navigate, route } from './router.ts'
import { resetChannels } from './store/channels.ts'
import { resetTimelines } from './store/messages.ts'
import { session, signedOut, type AuthErrorCode } from './store/session.ts'
import { offline, resetUi, showToast } from './store/ui.ts'
import { isTheme, setTheme } from './theme.ts'

export async function boot(): Promise<void> {
  session.value = { status: 'loading' }
  try {
    signIn(await api.me())
  } catch (error) {
    // No session (or a banned one): nothing personal of an earlier one stays on the device.
    if (isApiError(error, 'unauthenticated')) {
      removePref(LAST_CHANNEL_KEY)
      signedOut()
    } else if (isApiError(error, 'account_banned')) {
      removePref(LAST_CHANNEL_KEY)
      signedOut('banned')
    } else session.value = { status: 'unreachable' }
  }
}

function signIn(me: Me): void {
  syncPreferences(me)
  session.value = { status: 'signed-in', me }
}

/**
 * Language and theme: a choice made on this device wins and is saved to the account;
 * without one, a choice saved to the account from another device applies here. (The
 * account's defaults, English and console, are not a choice: the browser's language and
 * the system's colour scheme keep applying.)
 */
function syncPreferences(me: Me): void {
  const changes: { locale?: Me['locale']; theme?: Me['theme'] } = {}
  const localLocale = readPref('slax.locale')
  if (isLocale(localLocale)) {
    if (localLocale !== me.locale) changes.locale = localLocale
  } else if (isLocale(me.locale) && me.locale !== 'en') setLocale(me.locale)
  const localTheme = readPref('slax.theme')
  if (isTheme(localTheme)) {
    if (localTheme !== me.theme) changes.theme = localTheme
  } else if (isTheme(me.theme) && me.theme !== 'console') setTheme(me.theme)
  if (changes.locale || changes.theme) api.updateMe(changes).catch(() => undefined)
}

/**
 * Back to the sign-in screen, everything of the previous session forgotten: the stores, the
 * last open channel, Cache Storage and, unless the session merely expired, the browser's push
 * subscription (the device's language and theme stay).
 */
export function endSession(error: AuthErrorCode | null): void {
  removePref(LAST_CHANNEL_KEY)
  batch(() => {
    resetChannels()
    resetTimelines()
    resetUi()
    signedOut(error)
  })
  void clearAppCaches()
  // Expiry keeps this device's notifications (the person did not sign out; see pwa/push.ts).
  if (error !== 'session_expired') dropPushLocally()
  if (route.peek().name !== 'home') navigate('/', { replace: true })
}

/** What a sign-out pauses first: the presence heartbeat and polls (store/presence.ts). */
export interface Pausable {
  pause(): void
  resume(): void
}

/**
 * Sign-out, in an order that leaves nothing to bring the session back on the server:
 *  1. presence stops beating and polling;
 *  2. no request starts any more, and those already on their way are waited for (cut after
 *     3 s; see holdRequests);
 *  3. this device's notifications are removed from the account (pwa/push.ts);
 *  4. POST /auth/logout; then everything local is forgotten (endSession).
 * The server ends the session even if a request still reached it late (UserSessions::end);
 * this makes sure none does. A logout the server never got (offline) keeps the person signed
 * in, says so, and lets everything run again: signing out only on this device would sign them
 * back in at the next start online, since the session cookie is the server's to end. A 401
 * (the session already gone) ends it here too. Returns whether the session ended.
 */
export async function signOut(presence?: Pausable | null): Promise<boolean> {
  presence?.pause()
  await holdRequests()
  await forgetPushOnSignOut()
  try {
    await api.logout()
  } catch (error) {
    if (!isApiError(error, 'unauthenticated')) {
      releaseRequests()
      presence?.resume()
      return false
    }
  }
  endSession(null)
  releaseRequests()
  return true
}

/** App-wide reactions to what the API client reports. Returns the cleanup. */
export function installClientEvents(): () => void {
  return onClientEvent((event) => {
    switch (event.type) {
      case 'unauthorized':
        if (session.peek().status === 'signed-in') endSession('session_expired')
        break
      case 'banned':
        endSession('banned')
        break
      case 'rate-limited':
        showToast(
          {
            tone: 'error',
            key: 'rate-limited',
            text: event.retryAfter ? plural('error.rateLimited', event.retryAfter) : t('error.rateLimitedSoon'),
          },
          Math.max(6000, (event.retryAfter ?? 0) * 1000),
        )
        break
      case 'offline':
        offline.value = true
        break
      case 'online':
        offline.value = false
        break
    }
  })
}
