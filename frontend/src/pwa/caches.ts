/**
 * Sign-out on a shared family device: whatever Cache Storage holds goes. Today it holds the
 * public shell only (the service worker never caches the API, sign-in or files: sw-core.ts);
 * emptying it all, whatever a future version might add, keeps that promise without having
 * to trust a list. The workers then fetch the public shell again, for offline use.
 */
import { currentRegistration } from './register.ts'

export async function clearAppCaches(
  storage: CacheStorage | undefined = globalThis.caches,
  registration: ServiceWorkerRegistration | null = currentRegistration(),
): Promise<void> {
  if (!storage) return
  try {
    const names = await storage.keys()
    await Promise.all(names.map((name) => storage.delete(name)))
  } catch {
    // Storage refused (private mode, quota): nothing the sign-out can do about it.
    return
  }
  // The active worker, and a new version waiting to take over: each refills its own cache.
  for (const worker of [registration?.active, registration?.waiting]) worker?.postMessage({ type: 'PRECACHE' })
}
