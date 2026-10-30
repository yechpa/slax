import { plural } from '../../i18n/index.ts'

type Props = { emoji: string; count: number; mine?: boolean; onToggle?: () => void }

/** "[🚀 3]": pressed when the current user is one of the reactors. */
export function ReactionChip({ emoji, count, mine = false, onToggle }: Props) {
  return (
    <button
      type="button"
      class="reaction"
      aria-pressed={mine}
      aria-label={plural('reaction.label', count, { emoji })}
      onClick={onToggle}
    >
      <span class="reaction__emoji" aria-hidden="true">
        {emoji}
      </span>
      <span aria-hidden="true">{count}</span>
    </button>
  )
}
