/**
 * Web Push in the service worker, as plain functions (sw.ts wires them to the `push` and
 * `notificationclick` events), so every decision is unit-tested without a browser.
 *
 * - A push always becomes a notification, whatever its payload: the subscription is
 *   `userVisibleOnly`, and a browser may revoke push for a site whose pushes show nothing.
 * - The payload is the server's {type, title, body, url, tag} (backend PushPayload): sender and
 *   channel names and a generic line, never the message itself. `tag` is the conversation:
 *   a newer notification replaces the one before.
 * - A tap opens Slax: an open window of the app is focused and asked to show the
 *   conversation (push.ts navigates in place); otherwise a new window opens on it. Only a path
 *   of this app is ever opened: anything else (another origin, `//host`, `javascript:`) is
 *   ignored, and the tap just brings the app forward.
 */

export const FALLBACK_TITLE = 'Slax'
export const ICON = '/icons/icon-192.png'
const MAX_TITLE = 120
const MAX_BODY = 200
const MAX_TAG = 64

export interface PushNotice {
  title: string
  options: { body: string; tag: string; icon: string; badge: string; data: { url: string | null } }
}

/** The decrypted push message (PushMessageData): json() throws on anything that is not JSON. */
export interface PushDataLike {
  json(): unknown
}

/** A path of this app (`/c/12`, `/c/12/t/40`), or null for anything else. */
export function safeAppPath(url: unknown, origin: string): string | null {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return null
  try {
    const parsed = new URL(url, origin)
    return parsed.origin === origin ? parsed.pathname + parsed.search + parsed.hash : null
  } catch {
    return null
  }
}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

export function noticeFromPush(data: PushDataLike | null | undefined, origin: string): PushNotice {
  let payload: Record<string, unknown> = {}
  try {
    const parsed = data?.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
  } catch {
    // Not JSON (or not decryptable): the generic notification below.
  }
  const title = text(payload.title, MAX_TITLE)
  if (!title) {
    return { title: FALLBACK_TITLE, options: { body: '', tag: 'slax', icon: ICON, badge: ICON, data: { url: null } } }
  }
  return {
    title,
    options: {
      body: text(payload.body, MAX_BODY),
      tag: text(payload.tag, MAX_TAG) || 'slax',
      icon: ICON,
      badge: ICON,
      data: { url: safeAppPath(payload.url, origin) },
    },
  }
}

/** The `push` event: exactly one notification, always. */
export async function showPush(
  registration: { showNotification(title: string, options?: NotificationOptions): Promise<void> },
  data: PushDataLike | null | undefined,
  origin: string,
): Promise<void> {
  const notice = noticeFromPush(data, origin)
  await registration.showNotification(notice.title, notice.options)
}

export interface WindowLike {
  url: string
  focused?: boolean
  focus(): Promise<unknown>
  postMessage(message: unknown): void
}

export interface ClientsLike {
  matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowLike[]>
  openWindow(url: string): Promise<unknown>
}

/** The `notificationclick` event (the notification is closed by sw.ts). */
export async function openFromNotification(clients: ClientsLike, url: unknown, origin: string): Promise<void> {
  const path = safeAppPath(url, origin)
  const windows = (await clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((client) => {
    try {
      return new URL(client.url).origin === origin
    } catch {
      return false
    }
  })
  const target = windows.find((client) => client.focused) ?? windows[0]
  if (target) {
    await target.focus()
    if (path) target.postMessage({ type: 'OPEN_URL', url: path })
    return
  }
  await clients.openWindow(path ?? '/')
}
