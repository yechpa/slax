import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.ts'
import { SEARCH_DELAY_MS, createSearch } from './search.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('search as you type', () => {
  it('waits for a pause, aborts what is stale and never shows an older answer', async () => {
    const asked: { q: string; signal: AbortSignal; resolve: (r: string[]) => void; reject: (e: unknown) => void }[] = []
    const search = createSearch<string>(
      (q, signal) =>
        new Promise((resolve, reject) => {
          asked.push({ q, signal, resolve, reject })
        }),
    )

    search.query('d')
    search.query('da')
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS - 1)
    search.query('dan')
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS - 1)
    expect(asked).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(asked.map((a) => a.q)).toEqual(['dan'])
    expect(search.state.value.status).toBe('searching')

    // Typing on: the request in flight is aborted, its late answer ignored.
    search.query('dana')
    expect(asked[0].signal.aborted).toBe(true)
    asked[0].resolve(['stale'])
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS)
    expect(asked.map((a) => a.q)).toEqual(['dan', 'dana'])
    asked[1].resolve(['Dana Levi'])
    await vi.advanceTimersByTimeAsync(0)
    expect(search.state.value).toEqual({ query: 'dana', status: 'done', results: ['Dana Levi'] })

    // Spaces only: nothing is asked, nothing shown.
    search.query('   ')
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS)
    expect(asked).toHaveLength(2)
    expect(search.state.value).toEqual({ query: '', status: 'idle', results: [] })

    // A failure says so; an abort says nothing.
    search.query('x')
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS)
    asked[2].reject(new ApiError(500, 'server_error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(search.state.value.status).toBe('error')
    search.stop()
  })
})
