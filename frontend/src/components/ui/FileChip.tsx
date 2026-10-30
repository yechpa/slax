import { formatBytes } from '../../i18n/format.ts'
import { t } from '../../i18n/index.ts'
import { Button } from './Button.tsx'

type Props = {
  name: string
  bytes: number
  state?: 'ready' | 'scanning' | 'error'
  onRemove?: () => void
}

const extension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1, dot + 5) : 'file'
}

export function FileChip({ name, bytes, state = 'ready', onRemove }: Props) {
  return (
    <span class={`file-chip file-chip--${state}`}>
      <span class="file-chip__ext" aria-hidden="true">
        {extension(name)}
      </span>
      <bdi class="file-chip__name" title={name}>
        {name}
      </bdi>
      {/* <bdi>: "1.2 MB" would otherwise print as "MB 1.2" in a Hebrew line. */}
      <bdi class="file-chip__size">{state === 'scanning' ? t('file.scanning') : formatBytes(bytes)}</bdi>
      {onRemove && (
        <Button variant="quiet" size="sm" icon aria-label={t('file.remove', { name })} onClick={onRemove}>
          ×
        </Button>
      )}
    </span>
  )
}
