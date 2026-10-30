import type { ComponentChildren } from 'preact'
import { useId } from 'preact/hooks'
import { t } from '../../i18n/index.ts'
import { Button } from './Button.tsx'
import { Cursor } from './Cursor.tsx'

type Props = {
  channel: string
  value: string
  onInput: (value: string) => void
  onSend?: () => void
  onAttach?: () => void
  /** File chips waiting to be sent. */
  files?: ComponentChildren
}

/**
 * The message box, presentation only: "$" prompt, auto-growing textarea
 * (dir="auto", so Hebrew aligns itself), and a hand-drawn placeholder ending
 * in a blinking block cursor. Enter sends, Shift+Enter breaks the line.
 */
export function Composer({ channel, value, onInput, onSend, onAttach, files }: Props) {
  const hintId = useId()
  const placeholder = t('composer.placeholder', { channel })
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      onSend?.()
    }
  }
  return (
    <div class="composer">
      {files && <div class="composer__files">{files}</div>}
      <div class="composer__line">
        <span class="composer__prompt" aria-hidden="true">
          $
        </span>
        <div class="composer__field">
          <textarea
            class="composer__input"
            rows={1}
            // Empty, it follows the page; typed into, it follows its first strong letter.
            dir={value ? 'auto' : undefined}
            value={value}
            aria-label={`${t('composer.label')}: ${placeholder}`}
            aria-describedby={hintId}
            onInput={(event) => onInput(event.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          {value === '' && (
            <span class="composer__placeholder" aria-hidden="true">
              {placeholder}
              <Cursor />
            </span>
          )}
        </div>
      </div>
      <div class="composer__bar">
        <Button variant="quiet" size="sm" onClick={onAttach} aria-label={t('composer.attach')} title={t('composer.attach')}>
          +
        </Button>
        <span class="composer__hint" id={hintId}>
          {t('composer.hint')}
        </span>
        <Button variant="primary" size="sm" onClick={onSend} disabled={value.trim() === ''}>
          {t('action.send')}
        </Button>
      </div>
    </div>
  )
}
