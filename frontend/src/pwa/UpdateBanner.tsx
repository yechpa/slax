import { Button } from '../components/ui/Button.tsx'
import { t } from '../i18n/index.ts'
import { useLocale } from '../i18n/useLocale.ts'
import { applyUpdate, updateReady } from './register.ts'

/**
 * "A new version is ready": shown on every screen (signed in or not) once a new service
 * worker waits, until the person reloads. Not dismissible: an old app against a newer API
 * must not go unnoticed. It is a band above the screen, which shrinks to make room (app.css):
 * it never covers the composer, its Send or the header. The live region is always there, so
 * the message is announced.
 */
export function UpdateBanner() {
  useLocale()
  return (
    <div class="update-banner-region" role="status">
      {updateReady.value && (
        <p class="update-banner">
          <span class="update-banner__tag" aria-hidden="true">
            [^^]
          </span>
          <span class="update-banner__text">{t('pwa.update.ready')}</span>
          <Button variant="primary" size="sm" onClick={applyUpdate}>
            {t('pwa.update.reload')}
          </Button>
        </p>
      )}
    </div>
  )
}
