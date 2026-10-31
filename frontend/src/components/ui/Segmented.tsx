import { useId } from 'preact/hooks'

export type Option<T extends string> = { value: T; label: string; lang?: string; title?: string }

type Props<T extends string> = {
  legend: string
  value: T
  options: readonly Option<T>[]
  onChange: (value: T) => void
}

/** A radio group drawn as joined buttons: native keyboard behaviour, one Tab stop. */
export function Segmented<T extends string>({ legend, value, options, onChange }: Props<T>) {
  const name = useId()
  return (
    <fieldset class="segmented">
      <legend class="segmented__legend">{legend}</legend>
      <span class="segmented__options">
        {options.map((option) => (
          <label class="segmented__option" key={option.value} lang={option.lang} title={option.title}>
            <input
              class="segmented__input"
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </span>
    </fieldset>
  )
}
