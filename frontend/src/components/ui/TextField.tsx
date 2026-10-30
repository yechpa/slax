import type { PartialInputHTMLAttributes } from 'preact'
import { useId } from 'preact/hooks'

type Props = Omit<PartialInputHTMLAttributes<HTMLInputElement>, 'id' | 'type' | 'role' | 'list'> & {
  label: string
  hint?: string
  error?: string
}

export function TextField({ label, hint, error, class: extra, ...input }: Props) {
  const id = useId()
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  return (
    <div class={['field', extra].filter(Boolean).join(' ')}>
      <label class="field__label" for={id}>
        {label}
      </label>
      <input type="text" id={id} class="input" aria-invalid={error ? true : undefined} aria-describedby={described} {...input} />
      {hint && (
        <p class="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p class="field__error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  )
}
