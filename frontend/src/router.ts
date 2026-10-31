/**
 * A minimal router on the History API: a few routes, so no library.
 *   /             home: the app opens the first channel (or an empty state)
 *   /c/:id        a channel or conversation
 *   /c/:id/t/:mid the same, with the thread of message :mid open beside it
 *   /admin        administration (administrators only; the server checks every call)
 *   /privacy, /terms  the public legal pages (shown to everyone, signed in or not)
 * Anything else is `unknown` (shown as home). Same-origin links are intercepted
 * by `interceptLinks`, so plain <a href="/c/12"> elements navigate without a reload.
 */
import { signal } from '@preact/signals'

export type Route = { name: 'home' } | { name: 'channel'; id: number; thread: number | null } | { name: 'admin' } | { name: 'legal'; page: 'privacy' | 'terms' } | { name: 'unknown' }

export const ADMIN_PATH = '/admin'
const ID = '([1-9][0-9]{0,15})'
const CHANNEL = new RegExp(`^/c/${ID}(?:/t/${ID})?/?$`)

export function parseRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { name: 'home' }
  if (pathname === ADMIN_PATH || pathname === `${ADMIN_PATH}/`) return { name: 'admin' }
  const legal = /^\/(privacy|terms)\/?$/.exec(pathname)
  if (legal) return { name: 'legal', page: legal[1] as 'privacy' | 'terms' }
  const match = CHANNEL.exec(pathname)
  return match ? { name: 'channel', id: Number(match[1]), thread: match[2] ? Number(match[2]) : null } : { name: 'unknown' }
}

export const channelPath = (id: number) => `/c/${id}`
export const threadPath = (channelId: number, messageId: number) => `/c/${channelId}/t/${messageId}`

export const route = signal<Route>(parseRoute(globalThis.location?.pathname ?? '/'))

export function navigate(path: string, { replace = false } = {}): void {
  const url = new URL(path, location.href)
  if (url.pathname + url.search === location.pathname + location.search && !replace) return
  if (replace) history.replaceState(null, '', url)
  else history.pushState(null, '', url)
  route.value = parseRoute(url.pathname)
}

/** Keeps the route in step with Back/Forward; returns the cleanup. */
export function listenToHistory(): () => void {
  const onPopState = () => {
    route.value = parseRoute(location.pathname)
  }
  addEventListener('popstate', onPopState)
  return () => removeEventListener('popstate', onPopState)
}

/** Click handler for a container: in-app links navigate without reloading the page. */
export function interceptLinks(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return
  const url = new URL(link.href, location.href)
  if (url.origin !== location.origin || parseRoute(url.pathname).name === 'unknown') return
  // In-page anchors (the skip link) keep their native behaviour.
  if (url.hash && url.pathname === location.pathname) return
  event.preventDefault()
  navigate(url.pathname + url.search)
}
