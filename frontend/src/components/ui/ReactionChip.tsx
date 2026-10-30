import { plural } from '../../i18n/index.ts'

type Props = { emoji: string; count: number; mine?: boolean; disabled?: boolean; onToggle?: () => void }

/** "[🚀 3]": pressed when the current user is one of the reactors. */
export function ReactionChip({ emoji, count, mine = false, disabled = false, onToggle }: Props) {
  return (
    <button
      type="button"
      class="reaction"
      aria-pressed={mine}
      aria-label={plural('reaction.label', count, { emoji })}
      disabled={disabled}
      onClick={onToggle}
    >
      <span class="reaction__emoji" aria-hidden="true">
        {emoji}
      </span>
      {/* LTR-isolated digits: a count never reorders around the emoji. */}
      <bdi aria-hidden="true">{count}</bdi>
    </button>
  )
}
