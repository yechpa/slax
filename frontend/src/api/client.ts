/**
 * The one way the app talks HTTP to Laravel (same origin, through nginx).
 *
 * - Sanctum SPA session: cookies are always sent (`credentials: 'include'`), and every
 *   state-changing request carries `X-XSRF-TOKEN` (the URL-decoded XSRF-TOKEN cookie,
 *   fetched once from /sanctum/csrf-cookie). A 419 (expired token) refreshes it and
 *   retries once.
 * - Errors are typed (`ApiError`) with a stable `code`: the backend's own code when it
 *   sends one (`{"error": "turnstile_failed"}`), otherwise one derived from the status.
 * - Cross-cutting outcomes are announced to whoever listens (`onClientEvent`): 401 means
 *   signed out, 403 `account_banned` means banned, 429 needs a toast with a retry hint,
 *   a network failure means offline (and the next success, online again).
 */

/**
 * Derived from the status: unauthenticated (401), forbidden (403), not_found (404),
 * payload_too_large (413), csrf_mismatch (419), validation (422), rate_limited (429), server_error (5xx),
 * http_error, network (no response) and aborted. Otherwise the backend's own code
 * ({"error": "turnstile_failed"}, account_banned, sole_owner, …).
 */
export type ApiErrorCode = string

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  /** Validation messages per field (422). */
  readonly fields: Record<string, string[]>
  /** Seconds to wait (429, from Retry-After), when the server says. */
  readonly retryAfter: number | null
  /** The detail of a refusal, when the server gives one (`file_rejected` → `too_large`, …). */
  readonly reason: string | null

  constructor(
    status: number,
    code: ApiErrorCode,
    options: { fields?: Record<string, string[]>; retryAfter?: number | null; reason?: string | null } = {},
  ) {
    super(`${status} ${code}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.fields = options.fields ?? {}
    this.retryAfter = options.retryAfter ?? null
    this.reason = options.reason ?? null
  }
}

export const isApiError = (error: unknown, code?: ApiErrorCode): error is ApiError =>
  error instanceof ApiError && (code === undefined || error.code === code)

export type ClientEvent =
  | { type: 'unauthorized' }
  | { type: 'banned' }
  | { type: 'rate-limited'; retryAfter: number | null }
  | { type: 'offline' }
  | { type: 'online' }

const listeners = new Set<(event: ClientEvent) => void>()
let offline = false

export function onClientEvent(listener: (event: ClientEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(event: ClientEvent): void {
  for (const listener of [...listeners]) listener(event)
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /** An array repeats its key (`user_ids[]=1&user_ids[]=2`). */
  query?: Record<string, string | number | readonly number[] | undefined | null>
  signal?: AbortSignal
  /**
   * No app-wide side effects for this call's 401/429 (the caller handles them itself),
   * e.g. GET /me at start-up, where 401 simply means "not signed in yet".
   */
  quiet?: boolean
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

/** `/api/v1` + path. */
export const apiPath = (path: string) => `/api/v1${path}`

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return (await requestWithStatus<T>(path, options)).body
}

/** Like `request`, with the HTTP status of the success (201 created vs 200 existing). */
export async function requestWithStatus<T>(path: string, options: RequestOptions = {}): Promise<{ status: number; body: T }> {
  const method = options.method ?? 'GET'
  if (!SAFE.has(method)) await ensureCsrfCookie()
  let response = await send(path, method, options)
  if (response.status === 419 && !SAFE.has(method)) {
    // The session or its token expired: get a fresh one and try once more.
    await ensureCsrfCookie(true)
    response = await send(path, method, options)
  }
  return { status: response.status, body: await handle<T>(response, options) }
}

async function send(path: string, method: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const token = xsrfToken()
  if (token && !SAFE.has(method)) headers['X-XSRF-TOKEN'] = token
  try {
    return await globalThis.fetch(withQuery(path, options.query), {
      method,
      headers,
      credentials: 'include',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new ApiError(0, 'aborted')
    }
    noteOffline()
    throw new ApiError(0, 'network')
  }
}

async function handle<T>(response: Response, options: RequestOptions): Promise<T> {
  noteOnline()
  const body = await readJson(response)
  if (response.ok) return body as T
  throw failure(response.status, body, response.headers.get('Retry-After'), options)
}

/** A response came back: the network is there. */
export function noteOnline(): void {
  if (offline) {
    offline = false
    emit({ type: 'online' })
  }
}

/** No response at all: offline (announced once until the next response). */
export function noteOffline(): void {
  if (!offline) {
    offline = true
    emit({ type: 'offline' })
  }
}

/**
 * The ApiError for a refused request, announcing what the app reacts to (401, ban, 429).
 * Shared with uploads, which go through XMLHttpRequest for their progress.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON, checked field by field
export function failure(status: number, body: any, retryAfterHeader: string | null, options: { quiet?: boolean } = {}): ApiError {
  const serverCode = typeof body?.error === 'string' ? body.error : null
  const reason = typeof body?.reason === 'string' ? body.reason : null
  if (status === 401) {
    if (!options.quiet) emit({ type: 'unauthorized' })
    return new ApiError(status, 'unauthenticated')
  }
  if (status === 403 && serverCode === 'account_banned') {
    emit({ type: 'banned' })
    return new ApiError(status, serverCode)
  }
  if (status === 429) {
    const retryAfter = parseRetryAfter(retryAfterHeader)
    if (!options.quiet) emit({ type: 'rate-limited', retryAfter })
    return new ApiError(status, serverCode ?? 'rate_limited', { retryAfter })
  }
  if (status === 422 && !serverCode) {
    const fields = body && typeof body.errors === 'object' && body.errors !== null ? (body.errors as Record<string, string[]>) : {}
    return new ApiError(status, 'validation', { fields })
  }
  return new ApiError(status, serverCode ?? codeForStatus(status), { reason })
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 413) return 'payload_too_large'
  if (status === 419) return 'csrf_mismatch'
  if (status >= 500) return 'server_error'
  return 'http_error'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON, checked field by field
async function readJson(response: Response): Promise<any> {
  if (response.status === 204) return undefined
  return parseJson(await response.text().catch(() => ''))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON, checked by the caller
export function parseJson(text: string): any {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds))
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

function withQuery(path: string, query: RequestOptions['query']): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item))
    else if (value !== undefined && value !== null) params.set(key, String(value))
  }
  const search = params.toString()
  return search ? `${path}?${search}` : path
}

/** The XSRF-TOKEN cookie (set by Laravel, URL-encoded), as Laravel expects it back in X-XSRF-TOKEN. */
export function xsrfToken(): string | null {
  const cookie = globalThis.document?.cookie ?? ''
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === 'XSRF-TOKEN') {
      try {
        return decodeURIComponent(rest.join('='))
      } catch {
        return null
      }
    }
  }
  return null
}

let pendingCsrf: Promise<void> | null = null

/** Makes sure an XSRF-TOKEN cookie exists (one request at a time, shared by concurrent callers). */
export function ensureCsrfCookie(force = false): Promise<void> {
  if (!force && xsrfToken()) return Promise.resolve()
  pendingCsrf ??= globalThis
    .fetch('/sanctum/csrf-cookie', { credentials: 'include', headers: { Accept: 'application/json' } })
    .then(
      () => undefined,
      () => {
        // The request that needed it fails on its own and reports the network state.
      },
    )
    .finally(() => {
      pendingCsrf = null
    })
  return pendingCsrf
}

/** Test helper: forget the offline flag between tests. */
export function resetClientState(): void {
  offline = false
  pendingCsrf = null
}
