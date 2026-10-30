/**
 * Interface state shared across components: toasts, the connection banner, the mobile
 * navigation drawer and per-channel drafts. The current channel comes from the router,
 * the theme and language from theme.ts and i18n.
 */
import { computed, signal } from '@preact/signals'
import type { ConnectionState } from '../realtime/echo.ts'

export interface ToastItem {
  id: number
  tone: 'info' | 'success' | 'error'
  /** Already translated. */
  text: string
  /** One toast per key at a time (a second one replaces the first). */
  key?: string
}

export const toasts = signal<ToastItem[]>([])
let nextToast = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export function showToast(toast: Omit<ToastItem, 'id'>, timeoutMs = 6000): number {
  const id = nextToast++
  if (toast.key) for (const t of toasts.peek()) if (t.key === toast.key) dismissToast(t.id)
  // At most three on screen: the oldest goes first.
  toasts.value = [...toasts.peek(), { ...toast, id }].slice(-3)
  if (timeoutMs > 0) timers.set(id, setTimeout(() => dismissToast(id), timeoutMs))
  return id
}

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id))
  timers.delete(id)
  if (toasts.peek().some((t) => t.id === id)) toasts.value = toasts.peek().filter((t) => t.id !== id)
}

/** The realtime connection (set by the chat controller). */
export const connection = signal<ConnectionState>('connecting')
/** Set once the realtime connection was up at least once (a first connect is not an outage). */
export const everConnected = signal(false)
/** The last API call failed for lack of network (cleared by the next one that succeeds). */
export const offline = signal(false)
/** Realtime down for long enough to say so (a blip of a second is not worth a banner). */
export const realtimeDown = signal(false)

export const showConnectionBanner = computed(() => offline.value || realtimeDown.value)

/** Mobile: the channel list is open over the conversation. */
export const navOpen = signal(false)

/** Unsent text per composer (`c:12`, `t:40`), so switching channels keeps what was typed. */
export const drafts = new Map<string, string>()

/** The dialog open over the workspace, if any (sidebar actions). */
export const openDialog = signal<null | 'create-channel' | 'browse-channels' | 'new-message'>(null)

export function resetUi(): void {
  for (const id of [...timers.keys()]) dismissToast(id)
  toasts.value = []
  connection.value = 'connecting'
  everConnected.value = false
  offline.value = false
  realtimeDown.value = false
  navOpen.value = false
  openDialog.value = null
  drafts.clear()
}
