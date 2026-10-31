import { afterEach, describe, expect, it, vi } from 'vitest'
import { endSession } from '../session.ts'
import { flush } from '../test/fakes.ts'
import { clearAppCaches } from './caches.ts'

/** This origin's Cache Storage, with what the shell cache and anything else may hold. */
function fakeCaches(names: string[]) {
  const stores = new Set(names)
  return {
    stores,
    keys: vi.fn(async () => [...stores]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('clearAppCaches', () => {
  it('empties Cache Storage (all of it belongs to the app), then has the worker fetch the public shell again', async () => {
    const caches = fakeCaches(['slax-shell-abc', 'slax-shell-old', 'anything-else'])
    const active = { postMessage: vi.fn() }
    await clearAppCaches(caches as unknown as CacheStorage, { active } as unknown as ServiceWorkerRegistration)
    expect([...caches.stores]).toEqual([])
    expect(active.postMessage).toHaveBeenCalledWith({ type: 'PRECACHE' })
  })

  it('a version waiting to take over refills its own cache too (else it would start with none)', async () => {
    const caches = fakeCaches(['slax-shell-old', 'slax-shell-new'])
    const active = { postMessage: vi.fn() }
    const waiting = { postMessage: vi.fn() }
    await clearAppCaches(caches as unknown as CacheStorage, { active, waiting } as unknown as ServiceWorkerRegistration)
    expect(active.postMessage).toHaveBeenCalledWith({ type: 'PRECACHE' })
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'PRECACHE' })
  })

  it('does nothing where Cache Storage does not exist (insecure origin, old browser)', async () => {
    await expect(clearAppCaches(undefined, null)).resolves.toBeUndefined()
  })

  it('a failure is not the sign-out’s problem', async () => {
    const caches = { keys: vi.fn(async () => Promise.reject(new DOMException('denied', 'SecurityError'))) }
    await expect(clearAppCaches(caches as unknown as CacheStorage, null)).resolves.toBeUndefined()
  })
})

describe('endSession', () => {
  it.each([null, 'session_expired', 'banned'])('clears the caches whenever a session ends (%s): a shared device keeps nothing', async (reason) => {
    const caches = fakeCaches(['slax-shell-abc', 'private-leftover'])
    vi.stubGlobal('caches', caches)
    endSession(reason)
    await flush()
    expect([...caches.stores]).toEqual([])
  })
})
