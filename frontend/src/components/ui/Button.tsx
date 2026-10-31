import type { ButtonHTMLAttributes } from 'preact'

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  /** Square button holding a single glyph; give it an aria-label. */
  icon?: boolean
}

export function Button({ variant = 'secondary', size = 'md', icon = false, class: extra, type = 'button', ...rest }: Props) {
  const classes = ['btn', `btn--${variant}`, size === 'sm' && 'btn--sm', icon && 'btn--icon', extra]
  return <button type={type} class={classes.filter(Boolean).join(' ')} {...rest} />
}
