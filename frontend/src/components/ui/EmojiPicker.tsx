import { useEffect, useRef, useState } from 'preact/hooks'
import { t } from '../../i18n/index.ts'
import { PICKER_COLUMNS, PICKER_EMOJI } from '../../lib/emoji.ts'

type Props = {
  onPick: (emoji: string) => void
}

/**
 * A grid of common emoji, built in (no library, no network). One Tab stop: arrow keys
 * move (Up/Down by a row; Left/Right follow the reading direction), Home/End go to the
 * ends, Enter or Space picks. The emoji themselves are what screen readers announce.
 */
export function EmojiPicker({ onPick }: Props) {
  const [active, setActive] = useState(0)
  const grid = useRef<HTMLDivElement>(null)

  useEffect(() => {
    grid.current?.querySelectorAll<HTMLButtonElement>('.emoji-picker__item')[active]?.focus()
  }, [active])

  const onKeyDown = (event: KeyboardEvent) => {
    const rtl = grid.current ? getComputedStyle(grid.current).direction === 'rtl' : false
    const last = PICKER_EMOJI.length - 1
    let next: number
    switch (event.key) {
      case 'ArrowRight':
        next = active + (rtl ? -1 : 1)
        break
      case 'ArrowLeft':
        next = active + (rtl ? 1 : -1)
        break
      case 'ArrowDown':
        next = active + PICKER_COLUMNS
        break
      case 'ArrowUp':
        next = active - PICKER_COLUMNS
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = last
        break
      default:
        return
    }
    event.preventDefault()
    if (next >= 0 && next <= last) setActive(next)
  }

  return (
    <div class="emoji-picker" role="group" aria-label={t('reaction.picker')} ref={grid} onKeyDown={onKeyDown}>
      {PICKER_EMOJI.map((emoji, index) => (
        <button
          key={emoji}
          type="button"
          class="emoji-picker__item"
          tabIndex={index === active ? 0 : -1}
          onClick={() => onPick(emoji)}
          onFocus={() => setActive(index)}
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}
