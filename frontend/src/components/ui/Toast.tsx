import type { ComponentChildren } from 'preact'
import { t } from '../../i18n/index.ts'
import { Button } from './Button.tsx'

type Tone = 'info' | 'success' | 'error'

const TAGS: Record<Tone, string> = { info: '[i]', success: '[ok]', error: '[!!]' }

type Props = { tone?: Tone; children: ComponentChildren; action?: ComponentChildren; onClose?: () => void }

/** Errors interrupt (role=alert); everything else waits its turn (role=status). */
export function Toast({ tone = 'info', children, action, onClose }: Props) {
  return (
    <div class={`toast toast--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span class="toast__tag" aria-hidden="true">
        {TAGS[tone]}
      </span>
      <p class="toast__text">{children}</p>
      <div class="toast__actions">
        {action}
        {onClose && (
          <Button variant="quiet" size="sm" icon aria-label={t('action.close')} onClick={onClose}>
            ×
          </Button>
        )}
      </div>
    </div>
  )
}
