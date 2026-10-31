import type { ComponentChildren } from 'preact'
import { t } from '../../i18n/index.ts'

/**
 * What remains of a deleted message: same grid as a message, no author, no content.
 * Its thread stays reachable (`footer`: the thread link).
 */
export function Tombstone({ time, footer }: { time?: { iso: string; label: string }; footer?: ComponentChildren }) {
  return (
    <div class="message message--deleted">
      <span class="avatar avatar--empty" aria-hidden="true" />
      <div class="message__main">
        <p class="tombstone">
          {t('message.deleted')}
          {time && (
            <time class="message__time" dateTime={time.iso}>
              {time.label}
            </time>
          )}
        </p>
        {footer && <div class="message__footer">{footer}</div>}
      </div>
    </div>
  )
}
