/**
 * Search as you type: the request goes after a 250 ms pause in typing, the one still in
 * flight is aborted when the query changes, and an answer for an older query is never
 * shown (the network may answer out of order).
 */
import { signal } from '@preact/signals'
import { isApiError } from '../api/client.ts'

export const SEARCH_DELAY_MS = 250

export interface SearchState<T> {
  /** The trimmed query the results are for (or being fetched for). */
  query: string
  status: 'idle' | 'searching' | 'done' | 'error'
  results: T[]
}

export function createSearch<T>(fetcher: (query: string, signal: AbortSignal) => Promise<T[]>, delayMs = SEARCH_DELAY_MS) {
  const state = signal<SearchState<T>>({ query: '', status: 'idle', results: [] })
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: AbortController | null = null

  function cancel(): void {
    clearTimeout(timer)
    inFlight?.abort()
    inFlight = null
  }

  function query(text: string): void {
    const q = text.trim()
    cancel()
    if (q === '') {
      state.value = { query: '', status: 'idle', results: [] }
      return
    }
    // Earlier results stay on screen while the next ones come (no flicker).
    state.value = { ...state.peek(), query: q, status: 'searching' }
    timer = setTimeout(() => {
      const controller = new AbortController()
      inFlight = controller
      fetcher(q, controller.signal).then(
        (results) => {
          if (inFlight !== controller) return
          inFlight = null
          state.value = { query: q, status: 'done', results }
        },
        (error: unknown) => {
          if (inFlight !== controller || isApiError(error, 'aborted')) return
          inFlight = null
          state.value = { query: q, status: 'error', results: [] }
        },
      )
    }, delayMs)
  }

  return { state, query, stop: cancel }
}
