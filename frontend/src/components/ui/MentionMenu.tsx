import { t } from '../../i18n/index.ts'
import type { Match } from '../../lib/mentions.ts'
import { Avatar } from './Avatar.tsx'
import { userHue } from './hue.ts'

type Props = {
  id: string
  matches: readonly Match[]
  active: number
  /** The id of option `index`, for the field's aria-activedescendant. */
  optionId: (index: number) => string
  onPick: (match: Match) => void
}

/**
 * The people a mention being typed may name, in a listbox over the composer. The focus stays
 * in the text field (the pointer does not take it: mousedown is cancelled, so a tap on a phone
 * keeps the keyboard up); the field points at the active option with aria-activedescendant.
 */
export function MentionMenu({ id, matches, active, optionId, onPick }: Props) {
  return (
    <ul class="mention-menu" role="listbox" id={id} aria-label={t('mention.label')}>
      {matches.map((match, index) => (
        <li
          key={match.person.id}
          id={optionId(index)}
          role="option"
          aria-selected={index === active}
          class={index === active ? 'mention-menu__option mention-menu__option--active' : 'mention-menu__option'}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(match)}
        >
          <Avatar name={match.person.name} hue={userHue(String(match.person.id))} size="sm" presenceHidden />
          <bdi class="mention-menu__name">{match.person.name}</bdi>
          <bdi class="mention-menu__handle" dir="ltr">
            @{match.handle}
          </bdi>
        </li>
      ))}
    </ul>
  )
}
