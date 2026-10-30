import { formatBytes } from '../../i18n/format.ts'
import { getLocale, t } from '../../i18n/index.ts'
import { Button } from './Button.tsx'

type Props = {
  name: string
  bytes: number
  /** uploading: with `progress`. scanning: all sent, being checked. error: with `error`. */
  state?: 'ready' | 'uploading' | 'scanning' | 'error'
  /** 0..1 while uploading. */
  progress?: number
  /** Why it failed (translated), shown as its tooltip. */
  error?: string
  /** A link to the file (a message's attachment). */
  href?: string
  /** Removes it, or cancels it while it uploads. */
  onRemove?: () => void
  onRetry?: () => void
}

const extension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1, dot + 5) : 'file'
}

const percent = (fraction: number) => new Intl.NumberFormat(getLocale(), { style: 'percent' }).format(fraction)

/** A file: its extension, its name (isolated: a Hebrew name keeps its order), its size or state. */
export function FileChip({ name, bytes, state = 'ready', progress = 0, error, href, onRemove, onRetry }: Props) {
  let status: string
  if (state === 'scanning') status = t('file.scanning')
  else if (state === 'uploading') status = percent(progress)
  else if (state === 'error') status = t('file.failed')
  else status = formatBytes(bytes)
  const busy = state === 'uploading' || state === 'scanning'
  const content = (
    <>
      <span class="file-chip__ext" aria-hidden="true">
        {extension(name)}
      </span>
      <bdi class="file-chip__name" title={name}>
        {name}
      </bdi>
      {/* <bdi>: "1.2 MB" would otherwise print as "MB 1.2" in a Hebrew line. */}
      <bdi class="file-chip__size" title={error}>
        {status}
      </bdi>
    </>
  )
  return (
    <span class={`file-chip file-chip--${state}`} aria-busy={busy || undefined}>
      {href ? (
        <a class="file-chip__link" href={href} target="_blank" rel="noopener">
          {content}
        </a>
      ) : (
        content
      )}
      {state === 'uploading' && <progress class="file-chip__progress" max={1} value={progress} aria-label={t('file.uploading', { name })} />}
      {state === 'error' && error && <span class="sr-only">{error}</span>}
      {onRetry && (
        <Button variant="quiet" size="sm" aria-label={t('file.retry', { name })} onClick={onRetry}>
          {t('action.retry')}
        </Button>
      )}
      {onRemove && (
        <Button variant="quiet" size="sm" icon aria-label={t(busy ? 'file.cancel' : 'file.remove', { name })} title={t(busy ? 'file.cancel' : 'file.remove', { name })} onClick={onRemove}>
          ×
        </Button>
      )}
    </span>
  )
}
