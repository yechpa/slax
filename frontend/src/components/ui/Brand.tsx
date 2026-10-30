import { t } from '../../i18n/index.ts'
import { Cursor } from './Cursor.tsx'

/**
 * "> slax_" wordmark. The prompt is a plain ">" in logical order: it is a
 * Bidi_Mirrored character, so in a right-to-left page the browser draws "<",
 * pointing at the name from the other side.
 */
export function Brand({ cursor = false }: { cursor?: boolean }) {
  return (
    <span class="brand">
      <span aria-hidden="true">&gt;</span>
      <span class="brand__name">
        {t('app.name')}
        {cursor ? <Cursor /> : '_'}
      </span>
    </span>
  )
}
