import type { ComponentChildren, Ref } from 'preact'
import { useId, useRef } from 'preact/hooks'
import { plural, t } from '../../i18n/index.ts'
import { Button } from './Button.tsx'
import { Cursor } from './Cursor.tsx'

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
  /** Characters allowed (counted as code points, as the server does). The count shows near the end. */
  maxLength?: number
  inputRef?: Ref<HTMLTextAreaElement>
}

/** Remaining characters below which the counter appears. */
const COUNTER_FROM = 200

/** Code points, like the server's char_length (an emoji is one, not two UTF-16 units). */
export const charCount = (text: string) => [...text].length

/**
 * The message box, presentation only: "$" prompt, auto-growing textarea
 * (dir="auto", so Hebrew aligns itself), and a hand-drawn placeholder ending
 * in a blinking block cursor. Enter sends, Shift+Enter breaks the line; Enter
 * that confirms an IME composition (Japanese, Chinese, Korean input) does neither.
 */
export function Composer({ channel, placeholder: given, value, onInput, onSend, onAttach, files, maxLength, inputRef }: Props) {
  const hintId = useId()
  const counterId = useId()
  const composing = useRef(false)
  const placeholder = given ?? t('composer.placeholder', { channel })
  const length = maxLength === undefined ? 0 : charCount(value.trim())
  const remaining = maxLength === undefined ? Infinity : maxLength - length
  const showCounter = remaining <= COUNTER_FROM
  const blank = value.trim() === ''
  const sendable = !blank && remaining >= 0

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    // keyCode 229: some browsers (Safari) report the composition-ending Enter that way.
    if (event.isComposing || composing.current || event.keyCode === 229) return
    event.preventDefault()
    // Same rule as the disabled Send button: nothing (or too much) to send.
    if (sendable) onSend?.()
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
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={() => {
              composing.current = false
            }}
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
