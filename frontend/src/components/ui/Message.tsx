import type { ComponentChildren } from 'preact'
import { t } from '../../i18n/index.ts'
import { Avatar } from './Avatar.tsx'
import { hueStyle } from './hue.ts'

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
  /** Reactions, thread link… shown under the body. */
  footer?: ComponentChildren
  /** Hover / focus toolbar. */
  actions?: ComponentChildren
}

/**
 * One message, presentation only. The author is isolated in <bdi> (a Hebrew
 * name next to Latin digits stays in order) and the body is dir="auto".
 */
export function Message({ author, authorLang, hue, time, edited = false, mentioned = false, lang, children, footer, actions }: Props) {
  return (
    <article class={mentioned ? 'message message--mentioned' : 'message'} style={hueStyle(hue)}>
      <Avatar name={author} hue={hue} />
      <div class="message__main">
        <header class="message__meta">
          <bdi class="message__author" lang={authorLang}>
            {author}
          </bdi>
          <time class="message__time" dateTime={time.iso}>
            {time.label}
          </time>
          {edited && <span class="message__edited">{t('message.edited')}</span>}
        </header>
        <div class="message__body" dir="auto" lang={lang}>
          {children}
        </div>
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
