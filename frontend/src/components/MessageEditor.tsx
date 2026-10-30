/**
 * Editing one of my messages in place: Enter saves, Shift+Enter breaks the line, Escape
 * cancels; Enter that confirms an IME composition does neither. The text is measured as
 * the server measures it (trimBody, code points, 1 to 4000). Saving waits for the server
 * (its clock stamps the edit); a refusal is said in a toast and the editor stays open.
 */
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { isApiError } from '../api/client.ts'
import { plural, t } from '../i18n/index.ts'
import { MAX_BODY, charCount, trimBody } from '../lib/text.ts'
import { showToast } from '../store/ui.ts'
import { Button } from './ui/Button.tsx'
import { useIme } from './ui/useIme.ts'
import { useChat } from './chatContext.ts'

type Props = {
  messageId: number
  initial: string
  /** Saved or cancelled. */
  onDone: () => void
}

export function MessageEditor({ messageId, initial, onDone }: Props) {
  const chat = useChat()
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()
  const ime = useIme()
  const body = trimBody(value)
  const remaining = MAX_BODY - charCount(body)
  const blank = body === ''
  const valid = !blank && remaining >= 0

  useEffect(() => {
    const el = field.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const save = async () => {
    if (!valid || saving) return
    if (body === trimBody(initial)) {
      onDone()
      return
    }
    setSaving(true)
    try {
      await chat.editMessage(messageId, body)
      onDone()
    } catch (error) {
      setSaving(false)
      if (isApiError(error, 'rate_limited')) return
      if (isApiError(error, 'not_found')) {
        showToast({ tone: 'error', text: t('error.editGone'), key: 'edit' })
        onDone()
        return
      }
      showToast({ tone: 'error', text: t(isApiError(error, 'validation') ? 'error.editEmpty' : 'error.editFailed'), key: 'edit' })
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      // The editor's own: the thread panel or a drawer behind stays open.
      event.preventDefault()
      event.stopPropagation()
      onDone()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || ime.composing(event)) return
    event.preventDefault()
    void save()
  }

  return (
    <div class="message-editor">
      <textarea
        ref={field}
        class="message-editor__input"
        dir="auto"
        rows={1}
        value={value}
        readOnly={saving}
        aria-label={t('message.editLabel')}
        aria-describedby={hintId}
        aria-invalid={!valid || undefined}
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        {...ime.handlers}
      />
      <div class="message-editor__bar">
        <span class={blank ? 'message-editor__hint message-editor__hint--error' : 'message-editor__hint'} id={hintId}>
          {blank ? t('error.editEmpty') : remaining < 0 ? plural('composer.over', -remaining) : t('message.editHint')}
        </span>
        <Button variant="quiet" size="sm" onClick={onDone}>
          {t('action.cancel')}
        </Button>
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={!valid || saving}>
          {t('action.save')}
        </Button>
      </div>
    </div>
  )
}
