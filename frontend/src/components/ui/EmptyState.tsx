import type { ComponentChildren } from 'preact'
import { Cursor } from './Cursor.tsx'

export function EmptyState({ children }: { children: ComponentChildren }) {
  return (
    <div class="empty">
      <span class="empty__art" aria-hidden="true">
        &gt;
        <Cursor />
      </span>
      <p>{children}</p>
    </div>
  )
}
