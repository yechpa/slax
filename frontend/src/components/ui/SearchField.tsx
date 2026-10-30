import type { PartialInputHTMLAttributes } from 'preact'
import { t } from '../../i18n/index.ts'

type Props = Omit<PartialInputHTMLAttributes<HTMLInputElement>, 'type' | 'role' | 'list'> & { shortcut?: string }

/** Search box; its keyboard shortcut is drawn as a key cap at the inline end. */
export function SearchField({ shortcut = '/', class: extra, ...input }: Props) {
  return (
    <label class={['search', extra].filter(Boolean).join(' ')}>
      <span class="sr-only">{t('search.label')}</span>
      <input
        type="search"
        class="input"
        placeholder={t('search.placeholder')}
        aria-keyshortcuts={shortcut}
        {...input}
      />
      <kbd class="search__key" title={t('search.shortcut', { key: shortcut })}>
        {shortcut}
      </kbd>
    </label>
  )
}
