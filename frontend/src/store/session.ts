/** Who is signed in. `loading` until GET /me answered at start-up. */
import { computed, signal } from '@preact/signals'
import type { Me } from '../api/types.ts'

/** Stable codes shown on the signed-out screen (see auth.error.* in the dictionaries). */
export type AuthErrorCode = string

export type Session =
  | { status: 'loading' }
  | { status: 'unreachable' }
  | { status: 'signed-out'; error: AuthErrorCode | null }
  | { status: 'signed-in'; me: Me }

export const session = signal<Session>({ status: 'loading' })

export const me = computed(() => {
  const current = session.value
  return current.status === 'signed-in' ? current.me : null
})

export function signedOut(error: AuthErrorCode | null = null): void {
  session.value = { status: 'signed-out', error }
}
