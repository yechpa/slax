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
 * csrf_mismatch (419), validation (422), rate_limited (429), server_error (5xx),
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

  constructor(status: number, code: ApiErrorCode, options: { fields?: Record<string, string[]>; retryAfter?: number | null } = {}) {
    super(`${status} ${code}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.fields = options.fields ?? {}
    this.retryAfter = options.retryAfter ?? null
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
  query?: Record<string, string | number | undefined | null>
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
  const method = options.method ?? 'GET'
  if (!SAFE.has(method)) await ensureCsrfCookie()
  let response = await send(path, method, options)
  if (response.status === 419 && !SAFE.has(method)) {
    // The session or its token expired: get a fresh one and try once more.
    await ensureCsrfCookie(true)
    response = await send(path, method, options)
  }
  return handle<T>(response, options)
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
    if (!offline) {
      offline = true
      emit({ type: 'offline' })
    }
    throw new ApiError(0, 'network')
  }
}

async function handle<T>(response: Response, options: RequestOptions): Promise<T> {
  if (offline) {
    offline = false
    emit({ type: 'online' })
  }
  const body = await readJson(response)
  if (response.ok) return body as T

  const serverCode = typeof body?.error === 'string' ? body.error : null
  const status = response.status
  if (status === 401) {
    if (!options.quiet) emit({ type: 'unauthorized' })
    throw new ApiError(status, 'unauthenticated')
  }
  if (status === 403 && serverCode === 'account_banned') {
    emit({ type: 'banned' })
    throw new ApiError(status, serverCode)
  }
  if (status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
    if (!options.quiet) emit({ type: 'rate-limited', retryAfter })
    throw new ApiError(status, serverCode ?? 'rate_limited', { retryAfter })
  }
  if (status === 422 && !serverCode) {
    const fields = body && typeof body.errors === 'object' && body.errors !== null ? (body.errors as Record<string, string[]>) : {}
    throw new ApiError(status, 'validation', { fields })
  }
  throw new ApiError(status, serverCode ?? codeForStatus(status))
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 419) return 'csrf_mismatch'
  if (status >= 500) return 'server_error'
  return 'http_error'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON, checked field by field
async function readJson(response: Response): Promise<any> {
  if (response.status === 204) return undefined
  const text = await response.text().catch(() => '')
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
    if (value !== undefined && value !== null) params.set(key, String(value))
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
