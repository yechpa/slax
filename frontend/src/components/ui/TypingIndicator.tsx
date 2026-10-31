import { t } from '../../i18n/index.ts'

/** "dana is typing…", "dana and noam are typing…", "Several people are typing…". */
export function typingText(names: readonly string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return t('typing.one', { name: names[0] })
  if (names.length === 2) return t('typing.two', { first: names[0], second: names[1] })
  return t('typing.several')
}

/** Always takes its line, even when empty, so the composer never jumps. */
export function TypingIndicator({ names }: { names: readonly string[] }) {
  const text = typingText(names)
  return (
    <div class="typing" aria-live="polite">
      {text && (
        <>
          <span class="typing__dots" aria-hidden="true">
            <span class="typing__dot" />
            <span class="typing__dot" />
            <span class="typing__dot" />
          </span>
          <span>{text}</span>
        </>
      )}
    </div>
  )
}
