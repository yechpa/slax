import type { ComponentChildren } from 'preact'
import { t } from '../../i18n/index.ts'
import { Avatar } from './Avatar.tsx'
import { hueStyle } from './hue.ts'
import type { Presence } from './PresenceDot.tsx'

type Props = {
  author: string
  /** Language of the display name (screen readers pronounce it right). */
  authorLang?: string
  hue: number
  /** Machine-readable timestamp and its display form. */
  time: { iso: string; label: string }
  edited?: boolean
  mentioned?: boolean
  /** Language of the body, when known (e.g. demo content, or detected server-side). */
  lang?: string
  /** The message text: rendered in its own dir="auto" block, so each message picks its direction. */
  children: ComponentChildren
  /** Files, under the text (outside its dir="auto" block). */
  attachments?: ComponentChildren
  /** The author's presence, on the avatar. */
  presence?: Presence
  /** Reactions, thread link… shown under the body. */
  footer?: ComponentChildren
  /** Hover / focus toolbar. */
  actions?: ComponentChildren
  /**
   * A follow-up by the same author a moment later: no avatar and no visible header (the
   * time shows in the gutter on hover). Author and time stay readable by screen readers.
   */
  compact?: boolean
  /** Extra classes, e.g. message--pending, message--failed. */
  class?: string
  /** Still being sent. */
  busy?: boolean
  /** Replaces the body (e.g. the inline editor). */
  editor?: ComponentChildren
}

/**
 * One message, presentation only. The author is isolated in <bdi> (a Hebrew
 * name next to Latin digits stays in order) and the body is dir="auto".
 */
export function Message(props: Props) {
  const { author, authorLang, hue, time, edited = false, mentioned = false, lang, children, footer, actions, compact = false, busy, attachments, presence, editor } = props
  const classes = ['message', mentioned && 'message--mentioned', compact && 'message--compact', props.class]
  return (
    <article class={classes.filter(Boolean).join(' ')} style={hueStyle(hue)} aria-busy={busy || undefined}>
      {compact ? (
        <time class="message__gutter" dateTime={time.iso} aria-hidden="true">
          {time.label}
        </time>
      ) : (
        <Avatar name={author} hue={hue} presence={presence} presenceHidden />
      )}
      <div class="message__main">
        <header class={compact ? 'message__meta sr-only' : 'message__meta'}>
          <bdi class="message__author" lang={authorLang}>
            {author}
          </bdi>
          <time class="message__time" dateTime={time.iso}>
            {time.label}
          </time>
          {edited && !compact && <span class="message__edited">{t('message.edited')}</span>}
        </header>
        {editor ?? (
          <div class="message__body" dir="auto" lang={lang}>
            {children}
          </div>
        )}
        {edited && compact && !editor && <span class="message__edited">{t('message.edited')}</span>}
        {attachments && <div class="message__attachments">{attachments}</div>}
        {footer && <div class="message__footer">{footer}</div>}
      </div>
      {actions && (
        <div class="message__actions" role="toolbar" aria-label={t('message.actions')}>
          {actions}
        </div>
      )}
    </article>
  )
}
