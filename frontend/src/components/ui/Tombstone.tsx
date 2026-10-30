import { t } from '../../i18n/index.ts'

/** What remains of a deleted message: same grid as a message, no author, no content. */
export function Tombstone({ time }: { time?: { iso: string; label: string } }) {
  return (
    <div class="message">
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
      </div>
    </div>
  )
}
