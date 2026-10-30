/**
 * The scrolling message log of one channel.
 *
 * - Starts at the bottom (or at the "new messages" rule when the unread part is taller
 *   than the screen) and stays there while new messages arrive, but only if the reader
 *   was already at the bottom: otherwise a "new messages below" button appears.
 * - Loads older pages when scrolled near the top, keeping the reading position (the
 *   message that was first on screen stays where it was; browser scroll anchoring is
 *   off so it does not adjust twice).
 * - Day rules, the "new messages" rule (from the read pointer when the channel was
 *   opened), and grouping of consecutive messages by the same author within 5 minutes.
 */
import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { formatDay, sameDay } from '../i18n/format.ts'
import { t } from '../i18n/index.ts'
import type { Entry } from '../store/merge.ts'
import type { Timeline } from '../store/messages.ts'
import { Button } from './ui/Button.tsx'
import { Divider } from './ui/Divider.tsx'
import { EmptyState } from './ui/EmptyState.tsx'
import { MessageItem } from './MessageItem.tsx'

const GROUP_MS = 5 * 60 * 1000
/** Closer than this to the bottom counts as "at the bottom". */
const BOTTOM_SLACK = 48
/** Closer than this to the top starts loading the previous page. */
const TOP_TRIGGER = 400

type Props = {
  /** Shown in the list's name and the empty state, e.g. "#general". */
  label: string
  /** A conversation (dm, group): the start of the history is worded for people. */
  direct?: boolean
  timeline: Timeline
  meId: number | null
  /** Messages after this id (by others) are "new": the rule goes before the first one. */
  unreadAfter: number | null
  onLoadOlder: () => void
  /** Retry after a failed older page (scrolling alone no longer retries). */
  onRetryOlder: () => void
  onRetryLoad: () => void
  /** Retry the refresh that keeps failing after a reconnection. */
  onRetryRefresh: () => void
  onRetry: (clientId: string) => void
  onDiscard: (clientId: string) => void
  /**
   * Called whenever the reader is at the bottom of a visible, focused list, with a check
   * the caller runs again before acting (the reader may have left meanwhile).
   */
  onAtBottom: (stillReadable: () => boolean) => void
}

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'entry'; key: string; entry: Entry; compact: boolean }

const authorOf = (entry: Entry, meId: number | null): number | null => {
  if (entry.kind === 'pending') return meId
  return entry.message.deleted ? null : entry.message.user.id
}
const timeOf = (entry: Entry) => new Date(entry.kind === 'pending' ? entry.createdAt : entry.message.created_at)

export function buildRows(entries: readonly Entry[], meId: number | null, unreadAfter: number | null, now = new Date()): Row[] {
  const rows: Row[] = []
  let previous: Entry | null = null
  let unreadPlaced = false
  for (const entry of entries) {
    const when = timeOf(entry)
    const newDay = previous === null || !sameDay(timeOf(previous), when)
    if (newDay) rows.push({ kind: 'day', key: `day:${when.toDateString()}`, label: formatDay(when, now) })
    const author = authorOf(entry, meId)
    // Placed before the first message that counted as unread: someone else's, still there.
    const isUnread =
      !unreadPlaced &&
      unreadAfter !== null &&
      entry.kind === 'server' &&
      !entry.message.deleted &&
      entry.message.id > unreadAfter &&
      author !== meId
    if (isUnread) {
      rows.push({ kind: 'unread', key: 'unread' })
      unreadPlaced = true
    }
    const compact =
      previous !== null &&
      !newDay &&
      !isUnread &&
      author !== null &&
      author === authorOf(previous, meId) &&
      when.getTime() - timeOf(previous).getTime() < GROUP_MS
    rows.push({ kind: 'entry', key: entry.key, entry, compact })
    previous = entry
  }
  return rows
}

/** The row of an entry (offsetTop is relative to the list, which is positioned). */
function rowByKey(list: HTMLElement, key: string): HTMLElement | null {
  for (const row of list.querySelectorAll<HTMLElement>('.message-list__row')) if (row.dataset.key === key) return row
  return null
}

const prefersReducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

export function MessageList(props: Props) {
  const { label, timeline, meId, unreadAfter } = props
  const listRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const positioned = useRef(false)
  const lastSeen = useRef<{ firstKey: string | null; lastKey: string | null; anchorTop: number | null }>({ firstKey: null, lastKey: null, anchorTop: null })
  const [newBelow, setNewBelow] = useState(0)
  const { entries, status, hasMoreBefore, loadingOlder, olderFailed, refreshFailed } = timeline

  // Latest callbacks for listeners registered once.
  const latest = useRef(props)
  latest.current = props

  const scrollToBottom = useCallback((smooth = false) => {
    const el = listRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' })
    atBottom.current = true
    setNewBelow(0)
  }, [])

  const readable = useCallback(
    () => atBottom.current && document.visibilityState === 'visible' && document.hasFocus() && (listRef.current?.isConnected ?? false),
    [],
  )
  const reportIfReadable = useCallback(() => {
    if (readable()) latest.current.onAtBottom(readable)
  }, [readable])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK
    if (atBottom.current) {
      setNewBelow(0)
      reportIfReadable()
    }
    if (el.scrollTop < TOP_TRIGGER && positioned.current) latest.current.onLoadOlder()
  }

  // Position after each change of the entries: first load, older page, new messages.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const firstKey = entries[0]?.key ?? null
    const lastKey = entries.at(-1)?.key ?? null
    const seen = lastSeen.current

    if (!positioned.current) {
      if (status === 'ready') {
        positioned.current = true
        scrollToBottom()
        // A long unread stretch: start at its beginning instead.
        const rule = el.querySelector<HTMLElement>('.divider--new')
        if (rule && rule.offsetTop < el.scrollTop) {
          el.scrollTop = rule.offsetTop - 16
          atBottom.current = false
        }
      }
    } else {
      if (seen.firstKey !== null && firstKey !== seen.firstKey && seen.anchorTop !== null) {
        // Older messages were added above: keep the previous first message in place.
        const anchor = rowByKey(el, seen.firstKey)
        if (anchor) el.scrollTop += anchor.offsetTop - seen.anchorTop
      }
      if (lastKey !== seen.lastKey && lastKey !== null) {
        const last = entries.at(-1)!
        const mine = last.kind === 'pending' || (!last.message.deleted && last.message.user.id === meId)
        if (atBottom.current || mine) scrollToBottom()
        else if (seen.lastKey !== null) setNewBelow((n) => n + 1)
      }
    }
    const firstRow = firstKey ? rowByKey(el, firstKey) : null
    lastSeen.current = { firstKey, lastKey, anchorTop: firstRow?.offsetTop ?? null }
    reportIfReadable()
  }, [entries, status, meId, scrollToBottom, reportIfReadable])

  // A short first page that does not fill the screen: load more right away.
  useEffect(() => {
    const el = listRef.current
    if (el && status === 'ready' && hasMoreBefore && !loadingOlder && el.scrollHeight <= el.clientHeight + TOP_TRIGGER) {
      latest.current.onLoadOlder()
    }
  }, [status, hasMoreBefore, loadingOlder, entries])

  // Stay at the bottom when the list's box changes (composer grows, window resizes).
  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (atBottom.current && positioned.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Coming back to the tab or window: what is on screen may now count as read.
  useEffect(() => {
    document.addEventListener('visibilitychange', reportIfReadable)
    addEventListener('focus', reportIfReadable)
    return () => {
      document.removeEventListener('visibilitychange', reportIfReadable)
      removeEventListener('focus', reportIfReadable)
    }
  }, [reportIfReadable])

  let content: ComponentChildren
  if (status === 'error' && entries.length === 0) {
    content = (
      <EmptyState>
        {t('channel.loadError')}{' '}
        <Button variant="quiet" size="sm" onClick={props.onRetryLoad}>
          {t('action.retry')}
        </Button>
      </EmptyState>
    )
  } else if (status !== 'ready' && entries.length === 0) {
    content = <Skeleton />
  } else if (entries.length === 0 && !hasMoreBefore) {
    content = <EmptyState>{t('empty.channel', { channel: label })}</EmptyState>
  } else {
    content = (
      <>
        {hasMoreBefore && olderFailed ? (
          <p class="message-list__edge message-list__edge--failed">
            {t('message.olderFailed')}{' '}
            <Button variant="quiet" size="sm" onClick={props.onRetryOlder}>
              {t('action.retry')}
            </Button>
          </p>
        ) : hasMoreBefore ? (
          <p class="message-list__edge" aria-hidden={!loadingOlder}>
            {loadingOlder ? t('message.loadingOlder') : ''}
          </p>
        ) : (
          <p class="message-list__edge message-list__edge--start">
            {props.direct ? t('message.beginningDirect', { name: label }) : t('message.beginning', { channel: label })}
          </p>
        )}
        {buildRows(entries, meId, unreadAfter).map((row) => {
          if (row.kind === 'day') return <Divider key={row.key} label={row.label} />
          if (row.kind === 'unread') return <Divider key={row.key} label={t('divider.unread')} tone="new" />
          return (
            <div key={row.key} data-key={row.key} class="message-list__row">
              <MessageItem entry={row.entry} compact={row.compact} onRetry={props.onRetry} onDiscard={props.onDiscard} />
            </div>
          )
        })}
      </>
    )
  }

  return (
    <div class="message-pane">
      <div
        ref={listRef}
        class="message-list"
        id="messages"
        tabIndex={0}
        role="log"
        aria-label={t('message.list', { channel: label })}
        aria-busy={status === 'loading' || loadingOlder}
        onScroll={onScroll}
      >
        <div class="message-list__paper">{content}</div>
      </div>
      {/* Always present, so the notice is announced when it appears. */}
      <div class="refresh-notice-region" role="status">
        {refreshFailed && (
          <p class="refresh-notice">
            <span class="refresh-notice__tag" aria-hidden="true">
              [!!]
            </span>
            {t('channel.refreshFailed')}
            <Button variant="quiet" size="sm" onClick={props.onRetryRefresh}>
              {t('action.retry')}
            </Button>
          </p>
        )}
      </div>
      {newBelow > 0 && (
        <button type="button" class="jump-pill" onClick={() => scrollToBottom(true)}>
          {t('message.jumpToNew')}
          <span aria-hidden="true"> ↓</span>
        </button>
      )}
    </div>
  )
}

/** Placeholder rows while the first page loads: still, quiet, never mistaken for content. */
export function Skeleton() {
  return (
    <div class="skeleton" aria-hidden="true">
      {[62, 40, 75, 52, 30, 68].map((width, index) => (
        <div class="skeleton__row" key={index}>
          <span class="skeleton__avatar" />
          <span class="skeleton__lines">
            <span class="skeleton__line skeleton__line--name" />
            <span class={`skeleton__line skeleton__line--w${width}`} />
          </span>
        </div>
      ))}
    </div>
  )
}
