import type { ComponentChildren } from 'preact'
import { useEffect, useId, useRef } from 'preact/hooks'
import { t } from '../../i18n/index.ts'
import { Button } from './Button.tsx'

type Props = {
  title: string
  /** Shown under the title (e.g. what is about to happen). */
  description?: ComponentChildren
  onClose: () => void
  children?: ComponentChildren
  /** The buttons at the bottom. */
  footer?: ComponentChildren
  /** `alertdialog` for a confirmation. */
  role?: 'dialog' | 'alertdialog'
  /** Form submit (Enter in a field): the dialog body is a <form>. */
  onSubmit?: () => void
  class?: string
}

/**
 * A modal dialog on the native <dialog> (showModal): the rest of the page is inert, it
 * sits in the top layer (never clipped), and Escape closes it. Focus goes to the first
 * field (or the dialog), and back to what had it when the dialog closes.
 */
export function Dialog({ title, description, onClose, children, footer, role = 'dialog', onSubmit, class: extra }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement as HTMLElement | null
    if (!dialog.open) dialog.showModal?.()
    const first = dialog.querySelector<HTMLElement>('[data-autofocus], input:not([type="hidden"]), textarea, select')
    ;(first ?? dialog).focus()
    const onCancel = (event: Event) => {
      // Escape: closed by the app (it owns the state), not by the browser behind its back.
      event.preventDefault()
      close.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        close.current()
      }
    }
    dialog.addEventListener('cancel', onCancel)
    dialog.addEventListener('keydown', onKey)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      dialog.removeEventListener('keydown', onKey)
      if (dialog.open) dialog.close()
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  const body = (
    <>
      <header class="dialog__header">
        <h2 class="dialog__title" id={titleId}>
          {title}
        </h2>
        <Button variant="quiet" size="sm" icon class="dialog__close" aria-label={t('action.close')} onClick={() => close.current()}>
          ×
        </Button>
      </header>
      {description && (
        <div class="dialog__description" id={descriptionId}>
          {description}
        </div>
      )}
      {children && <div class="dialog__body">{children}</div>}
      {footer && <footer class="dialog__footer">{footer}</footer>}
    </>
  )

  return (
    <dialog
      ref={ref}
      class={['dialog', extra].filter(Boolean).join(' ')}
      role={role === 'alertdialog' ? 'alertdialog' : undefined}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      tabIndex={-1}
    >
      {onSubmit ? (
        <form
          class="dialog__form"
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
        >
          {body}
        </form>
      ) : (
        <div class="dialog__form">{body}</div>
      )}
    </dialog>
  )
}
