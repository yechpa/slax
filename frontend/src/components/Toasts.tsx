import { t } from '../i18n/index.ts'
import { useLocale } from '../i18n/useLocale.ts'
import { dismissToast, showConnectionBanner, toasts } from '../store/ui.ts'
import { Toast } from './ui/Toast.tsx'

// Prop-less: re-rendered on a change of language by useLocale only (see Workspace).
export function Toasts() {
  useLocale()
  return (
    <div class="toast-region toast-region--app">
      {toasts.value.map((toast) => (
        <Toast key={toast.id} tone={toast.tone} onClose={() => dismissToast(toast.id)}>
          {toast.text}
        </Toast>
      ))}
    </div>
  )
}

/** A quiet line at the top while the connection is down (the live region is always there). */
export function ConnectionBanner() {
  useLocale()
  return (
    <div class="conn-banner-region" role="status">
      {showConnectionBanner.value && (
        <p class="conn-banner">
          <span class="conn-banner__tag" aria-hidden="true">
            [!!]
          </span>
          {t('error.network')}
        </p>
      )}
    </div>
  )
}
