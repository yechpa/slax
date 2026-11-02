import type { RefObject } from 'preact'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { insertMention, matchPeople, mentionAt, menuKey, type Candidate, type Match } from '../../lib/mentions.ts'

export type MentionSource = {
  /** Who can be mentioned here: members other than the author, not banned. */
  people: readonly Candidate[]
  /** A mention was just started: load the people if they are not there yet. */
  onStart?: () => void
}

type Args = {
  value: string
  source: MentionSource | undefined
  onChange: (value: string) => void
  input: RefObject<HTMLTextAreaElement | null>
}

/**
 * The state of the @mention menu of a text field: the caret, the mention being typed at it,
 * who matches, the active option, and the keyboard. The field spreads `fieldProps`, calls
 * `keyDown` first in its keydown handler (true: the key was the menu's), and shows the menu
 * and `announcement` when `open`.
 */
export function useMentionMenu({ value, source, onChange, input }: Args) {
  const listId = useId()
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  // The `@` the user sent away with Escape stays closed until the mention is over.
  const [dismissed, setDismissed] = useState<number | null>(null)
  const place = useRef<number | null>(null)

  const trigger = source ? mentionAt(value, caret) : null
  const matches: Match[] = trigger && source ? matchPeople(source.people, trigger.query) : []
  const open = trigger !== null && matches.length > 0 && dismissed !== trigger.start
  const index = Math.min(active, Math.max(matches.length - 1, 0))
  const optionId = (at: number) => `${listId}-${at}`

  const started = trigger !== null
  useEffect(() => {
    if (started) source?.onStart?.()
    else setDismissed(null)
    // Once per mention started, not at every keystroke in it.
  }, [started])

  // After a pick the field is re-rendered with the new text: the caret goes after the mention then.
  useLayoutEffect(() => {
    const at = place.current
    if (at === null) return
    place.current = null
    input.current?.setSelectionRange(at, at)
  }, [value])

  const sync = (field: HTMLTextAreaElement) => {
    // A selection is not a caret: no mention is completed over a highlighted range.
    setCaret(field.selectionStart === field.selectionEnd ? field.selectionStart : -1)
  }

  const pick = (match: Match) => {
    if (!trigger) return
    const next = insertMention(value, trigger, match.handle)
    place.current = next.caret
    setCaret(next.caret)
    setActive(0)
    onChange(next.text)
    input.current?.focus()
  }

  const keyDown = (event: KeyboardEvent): boolean => {
    const action = menuKey(event, open, matches.length, index)
    if (!action) return false
    event.preventDefault()
    if (action.type === 'move') setActive(action.index)
    else if (action.type === 'pick') pick(matches[index])
    else {
      // Closes the menu only: not the thread panel or the drawer around it.
      event.stopPropagation()
      setDismissed(trigger?.start ?? null)
    }
    return true
  }

  return {
    open,
    matches,
    active: index,
    listId,
    optionId,
    pick,
    keyDown,
    fieldProps: source
      ? {
          'aria-haspopup': 'listbox' as const,
          'aria-controls': open ? listId : undefined,
          'aria-activedescendant': open ? optionId(index) : undefined,
          onKeyUp: (event: KeyboardEvent) => sync(event.currentTarget as HTMLTextAreaElement),
          onClick: (event: MouseEvent) => sync(event.currentTarget as HTMLTextAreaElement),
          onFocus: (event: FocusEvent) => sync(event.currentTarget as HTMLTextAreaElement),
          onSelect: (event: Event) => sync(event.currentTarget as HTMLTextAreaElement),
        }
      : {},
    /** The field's text changed: the caret is where the browser left it. */
    typed: (field: HTMLTextAreaElement) => {
      sync(field)
      setActive(0)
    },
  }
}
