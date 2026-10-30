import { useId } from 'preact/hooks'
import { Button } from '../components/ui/Button.tsx'
import { t } from '../i18n/index.ts'
import { useLocale } from '../i18n/useLocale.ts'
import { install, installPrompt, installVariant, isIos, isStandalone } from './install.ts'

/**
 * In Settings (the account menu): Install (Chromium), or how to add Slax to the Home Screen
 * (iOS), or nothing (already installed, or a browser that cannot install).
 */
export function InstallPrompt() {
  useLocale()
  const titleId = useId()
  const variant = installVariant({ standalone: isStandalone(), ios: isIos(), canPrompt: installPrompt.value !== null })
  if (variant === 'none') return null
  if (variant === 'prompt') {
    return (
      <section class="install" aria-labelledby={titleId}>
        <p class="install__title" id={titleId}>
          {t('pwa.install.title')}
        </p>
        <p class="install__hint">{t('pwa.install.hint')}</p>
        <Button size="sm" class="install__action" onClick={() => void install()}>
          {t('pwa.install.action')}
        </Button>
      </section>
    )
  }
  return (
    <section class="install" aria-labelledby={titleId}>
      <p class="install__title" id={titleId}>
        {t('pwa.install.ios.title')}
      </p>
      <ol class="install__steps">
        <li>{t('pwa.install.ios.step1')}</li>
        <li>{t('pwa.install.ios.step2')}</li>
        <li>{t('pwa.install.ios.step3')}</li>
      </ol>
    </section>
  )
}
