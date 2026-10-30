import type { ComponentChildren, Ref } from 'preact'
import { useId } from 'preact/hooks'
import { plural, t } from '../../i18n/index.ts'
import { charCount, trimBody } from '../../lib/text.ts'
import { Button } from './Button.tsx'
import { Cursor } from './Cursor.tsx'
import { useIme } from './useIme.ts'

type Props = {
  channel: string
  /** Replaces "Message #channel" (e.g. "Message dana" in a conversation). */
  placeholder?: string
  value: string
  onInput: (value: string) => void
  onSend?: () => void
  /** Shows the "+" attach button when given. */
  onAttach?: () => void
  /** File chips waiting to be sent. */
  files?: ComponentChildren
  /** Finished uploads are attached: the text may be empty (a file-only message). */
  hasFiles?: boolean
  /** Uploads still on their way: Send waits for them. */
  busy?: boolean
  onPaste?: (event: ClipboardEvent) => void
  onBlur?: () => void
  /** Characters allowed (counted as code points, as the server does). The count shows near the end. */
  maxLength?: number
  inputRef?: Ref<HTMLTextAreaElement>
}

/** Remaining characters below which the counter appears. */
const COUNTER_FROM = 200

/**
 * The message box, presentation only: "$" prompt, auto-growing textarea
 * (dir="auto", so Hebrew aligns itself), and a hand-drawn placeholder ending
 * in a blinking block cursor. Enter sends, Shift+Enter breaks the line; Enter
 * that confirms an IME composition (Japanese, Chinese, Korean input) does neither.
 */
export function Composer(props: Props) {
  const { channel, placeholder: given, value, onInput, onSend, onAttach, files, hasFiles = false, busy = false, maxLength, inputRef } = props
  const hintId = useId()
  const counterId = useId()
  const ime = useIme()
  const placeholder = given ?? t('composer.placeholder', { channel })
  // Measured exactly as the server will: same trim, same count.
  const body = trimBody(value)
  const remaining = maxLength === undefined ? Infinity : maxLength - charCount(body)
  const showCounter = remaining <= COUNTER_FROM
  const blank = body === ''
  const sendable = (!blank || hasFiles) && remaining >= 0 && !busy

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (ime.composing(event)) return
    event.preventDefault()
    // Same rule as the disabled Send button: nothing (or too much) to send.
    if (sendable) onSend?.()
  }
  return (
    <div class="composer">
      {files && (
        <div class="composer__files" aria-label={t('composer.files')} role="group">
          {files}
        </div>
      )}
      <div class="composer__line">
        <span class="composer__prompt" aria-hidden="true">
          $
        </span>
        <div class="composer__field">
          <textarea
            ref={inputRef}
            class="composer__input"
            rows={1}
            // Empty, it follows the page; typed into, it follows its first strong letter.
            dir={value ? 'auto' : undefined}
            value={value}
            aria-label={`${t('composer.label')}: ${placeholder}`}
            aria-describedby={showCounter ? `${hintId} ${counterId}` : hintId}
            aria-invalid={remaining < 0 || undefined}
            onInput={(event) => onInput(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            onPaste={props.onPaste}
            onBlur={props.onBlur}
            {...ime.handlers}
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
        {onAttach && (
          <Button variant="quiet" size="sm" onClick={onAttach} aria-label={t('composer.attach')} title={t('composer.attach')}>
            +
          </Button>
        )}
        <span class="composer__hint" id={hintId}>
          {t('composer.hint')}
        </span>
        {showCounter && (
          <span class={remaining < 0 ? 'composer__counter composer__counter--over' : 'composer__counter'} id={counterId} aria-live="polite">
            {remaining < 0 ? plural('composer.over', -remaining) : plural('composer.remaining', remaining)}
          </span>
        )}
        <Button variant="primary" size="sm" onClick={onSend} disabled={!sendable}>
          {t('action.send')}
        </Button>
      </div>
    </div>
  )
}
