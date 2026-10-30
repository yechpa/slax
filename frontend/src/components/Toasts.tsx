import { t } from '../i18n/index.ts'
import { dismissToast, showConnectionBanner, toasts } from '../store/ui.ts'
import { Toast } from './ui/Toast.tsx'

export function Toasts() {
  return (
    <div class="toast-region">
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
