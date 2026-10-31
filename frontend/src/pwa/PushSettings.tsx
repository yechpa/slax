import { useEffect, useId } from 'preact/hooks'
import { Button } from '../components/ui/Button.tsx'
import { t } from '../i18n/index.ts'
import { useLocale } from '../i18n/useLocale.ts'
import { disablePush, enablePush, initPush, pushBusy, pushStatus, sendTestPush } from './push.ts'

/**
 * In Settings (the account menu): the "Notifications on this device" switch and a test button,
 * the iPhone's "install first" help, or nothing (no VAPID keys on the server, no Push API).
 * See push.ts for what each state means.
 */
export function PushSettings() {
  useLocale()
  const titleId = useId()
  useEffect(() => {
    void initPush()
  }, [])
  const status = pushStatus.value
  if (status === 'hidden') return null
  return (
    <section class="push" aria-labelledby={titleId}>
      <p class="push__title" id={titleId}>
        {t('push.title')}
      </p>
      {status === 'install-first' ? (
        <p class="push__hint">{t('push.installFirst')}</p>
      ) : (
        <>
          <label class="push__toggle">
            <input
              type="checkbox"
              role="switch"
              class="push__switch"
              checked={status === 'on'}
              disabled={pushBusy.value || status === 'blocked'}
              // The permission prompt must come from this tap or click (enablePush asks first).
              onChange={(event) => void (event.currentTarget.checked ? enablePush() : disablePush())}
            />
            {t('push.toggle')}
          </label>
          <p class="push__hint">{t(status === 'blocked' ? 'push.blocked' : 'push.hint')}</p>
          {status === 'on' && (
            <Button size="sm" variant="secondary" class="push__test" onClick={() => void sendTestPush()}>
              {t('push.test')}
            </Button>
          )}
        </>
      )}
    </section>
  )
}
