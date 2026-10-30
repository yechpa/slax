import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pollWhileVisible } from './poll.ts'

let visibility: DocumentVisibilityState = 'visible'
const show = (state: DocumentVisibilityState) => {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})

afterEach(() => {
  vi.useRealTimers()
  // Back to happy-dom's own property.
  delete (document as { visibilityState?: unknown }).visibilityState
})

describe('pollWhileVisible', () => {
  it('refreshes on its timer while visible, never while hidden, and once when shown again', () => {
    const refresh = vi.fn()
    const stop = pollWhileVisible(refresh, { everyMs: 60_000, staleAfterMs: 15_000 })

    vi.advanceTimersByTime(60_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    // A hidden tab: ten minutes, no request.
    show('hidden')
    vi.advanceTimersByTime(10 * 60_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    // Shown again: once, at once; then on the timer again.
    show('visible')
    expect(refresh).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60_000)
    expect(refresh).toHaveBeenCalledTimes(3)

    // Hidden for a moment only: nothing more on return (it is fresh).
    vi.advanceTimersByTime(5_000)
    show('hidden')
    vi.advanceTimersByTime(5_000)
    show('visible')
    expect(refresh).toHaveBeenCalledTimes(3)

    stop()
    vi.advanceTimersByTime(10 * 60_000)
    show('hidden')
    show('visible')
    expect(refresh).toHaveBeenCalledTimes(3)
  })
})
