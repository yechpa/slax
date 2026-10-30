/**
 * Picking people by name: a combobox searching the directory as you type (debounced,
 * stale requests aborted), the choices shown as chips before the field. Up and Down move
 * through the suggestions, Enter takes one, Backspace in an empty field removes the last
 * chip, Escape clears what was typed (a second Escape is the dialog's).
 *
 * At the limit (`full`) the field takes no more text, says why (`fullText`, announced), and
 * keeps the focus: Backspace still removes the last chip.
 */
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { api } from '../api/endpoints.ts'
import type { UserSummary } from '../api/types.ts'
import { t } from '../i18n/index.ts'
import { createSearch } from '../lib/search.ts'
import { rememberPeople } from '../store/people.ts'
import { Avatar } from './ui/Avatar.tsx'
import { userHue } from './ui/hue.ts'
import { useChat } from './chatContext.ts'
import { useTrackPresence } from './usePresence.ts'

type Props = {
  label: string
  placeholder: string
  /** Under the field: what can be picked. */
  hint?: string
  selected: readonly UserSummary[]
  onSelect: (person: UserSummary) => void
  onRemove?: (person: UserSummary) => void
  /** Not offered (already chosen, already members). */
  exclude?: readonly number[]
  /** Not offered: the members of this channel, however many (left out by the server). */
  notInChannel?: number
  /** No more can be picked: the field says so (`fullText`) and takes no more. */
  full?: boolean
  /** Why no more can be picked ("7 people at most."). */
  fullText?: string
  disabled?: boolean
}

export function PeoplePicker({ label, placeholder, hint, selected, onSelect, onRemove, exclude = [], notInChannel, full = false, fullText, disabled = false }: Props) {
  const chat = useChat()
  const channel = useRef(notInChannel)
  channel.current = notInChannel
  const [search] = useState(() => createSearch<UserSummary>((q, signal) => api.searchUsers(q, signal, channel.current)))
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const inputId = useId()
  const hintId = useId()
  const listId = useId()
  const state = search.state.value
  const skip = new Set([...exclude, ...selected.map((p) => p.id)])
  const options = state.results.filter((person) => !skip.has(person.id))
  const open = text.trim() !== ''
  useTrackPresence('people-picker', options.map((p) => p.id))

  useEffect(() => () => search.stop(), [search])
  useEffect(() => rememberPeople(state.results), [state.results])
  useEffect(() => setActive(0), [state.results])

  const choose = (person: UserSummary) => {
    onSelect(person)
    setText('')
    search.query('')
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (options.length === 0) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((active + step + options.length) % options.length)
    } else if (event.key === 'Enter') {
      const person = options[active]
      if (!open || !person) return
      // Takes the suggestion; the form is not submitted.
      event.preventDefault()
      choose(person)
    } else if (event.key === 'Escape' && text !== '') {
      event.preventDefault()
      event.stopPropagation()
      setText('')
      search.query('')
    } else if (event.key === 'Backspace' && text === '' && selected.length > 0 && onRemove) {
      onRemove(selected[selected.length - 1])
    }
  }

  let status = ''
  if (full) status = fullText ?? ''
  else if (open) {
    if (state.status === 'error') status = t('people.error')
    else if (state.status === 'searching' && options.length === 0) status = t('people.searching')
    else if (state.status === 'done' && options.length === 0) status = t('people.none', { query: state.query })
  }
  const optionId = (index: number) => `${listId}-${index}`

  return (
    <div class="people-picker">
      <label class="field__label" for={inputId}>
        {label}
      </label>
      <div class={disabled || full ? 'people-picker__box people-picker__box--disabled' : 'people-picker__box'}>
        {selected.map((person) => (
          <span class="person-chip" key={person.id}>
            <Avatar name={person.name} hue={userHue(String(person.id))} size="sm" />
            <bdi class="person-chip__name">{person.name}</bdi>
            {onRemove && (
              <button type="button" class="person-chip__remove" aria-label={t('people.remove', { name: person.name })} onClick={() => onRemove(person)} disabled={disabled}>
                ×
              </button>
            )}
          </span>
        ))}
        <input
          id={inputId}
          class="people-picker__input"
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck={false}
          aria-autocomplete="list"
          aria-expanded={open && options.length > 0}
          aria-controls={listId}
          aria-activedescendant={open && options[active] ? optionId(active) : undefined}
          aria-describedby={hint ? hintId : undefined}
          placeholder={full ? '' : placeholder}
          value={text}
          disabled={disabled}
          // Not disabled at the limit: it would lose the focus, and Backspace with it.
          readOnly={full}
          aria-disabled={full || undefined}
          onInput={(event) => {
            setText(event.currentTarget.value)
            search.query(event.currentTarget.value)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {hint && (
        <p class="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      <ul class="people-picker__options" role="listbox" id={listId} aria-label={t('people.results')} hidden={!open || options.length === 0}>
        {options.map((person, index) => (
          <li
            key={person.id}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            class={index === active ? 'people-picker__option people-picker__option--active' : 'people-picker__option'}
            // Keeps the focus in the field.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(person)}
          >
            <Avatar name={person.name} hue={userHue(String(person.id))} size="sm" presence={chat.presence.stateOf(person.id)} />
            <bdi class="people-picker__name">{person.name}</bdi>
          </li>
        ))}
      </ul>
      <p class="people-picker__status" role="status">
        {status}
      </p>
    </div>
  )
}
