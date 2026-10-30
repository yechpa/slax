/**
 * Test helper: make every access to `localStorage` throw, as browsers do when
 * site data is blocked (SecurityError on the getter), then restore it.
 */
export function withBrokenStorage<T>(run: () => T): T {
  const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    },
  })
  try {
    return run()
  } finally {
    if (own) Object.defineProperty(globalThis, 'localStorage', own)
    else delete (globalThis as { localStorage?: Storage }).localStorage
  }
}
