/** The reactions under a message: a chip per emoji (pressed when mine), and "+" for another. */
import { useRef, useState } from 'preact/hooks'
import type { Reaction } from '../api/types.ts'
import { t } from '../i18n/index.ts'
import { EmojiPicker } from './ui/EmojiPicker.tsx'
import { Popover } from './ui/Popover.tsx'
import { ReactionChip } from './ui/ReactionChip.tsx'

type Props = {
  reactions: readonly Reaction[]
  /** Not a member (a public channel being read): the chips are shown, not pressable. */
  canReact: boolean
  onToggle: (emoji: string) => void
}

export function Reactions({ reactions, canReact, onToggle }: Props) {
  const [picking, setPicking] = useState(false)
  const add = useRef<HTMLButtonElement>(null)
  if (reactions.length === 0) return null
  return (
    <div class="message__reactions">
      {reactions.map((reaction) => (
        <ReactionChip
          key={reaction.emoji}
          emoji={reaction.emoji}
          count={reaction.count}
          mine={reaction.reacted_by_me}
          disabled={!canReact}
          onToggle={() => onToggle(reaction.emoji)}
        />
      ))}
      {canReact && (
        <button
          ref={add}
          type="button"
          class="reaction reaction--add"
          aria-label={t('reaction.addTo')}
          title={t('reaction.addTo')}
          aria-expanded={picking}
          onClick={() => setPicking(!picking)}
        >
          +
        </button>
      )}
      {picking && (
        <Popover
          anchor={add}
          onClose={(restore) => {
            setPicking(false)
            if (restore) add.current?.focus()
          }}
        >
          <EmojiPicker
            onPick={(emoji) => {
              setPicking(false)
              add.current?.focus()
              onToggle(emoji)
            }}
          />
        </Popover>
      )}
    </div>
  )
}
