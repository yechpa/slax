/**
 * Files dragged over a channel (or a thread) show a drop zone over it; dropped, they go
 * to its composer. Only file drags count (a dragged text selection is left alone). The
 * wrapper has no box of its own (display: contents), so the layout is unchanged.
 */
import type { ComponentChildren } from 'preact'
import { useRef, useState } from 'preact/hooks'
import { t } from '../i18n/index.ts'

const carriesFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files')

export function DropZone({ onFiles, children }: { onFiles: (files: File[]) => void; children: ComponentChildren }) {
  const [over, setOver] = useState(false)
  // dragenter/dragleave fire for every child crossed: count them.
  const depth = useRef(0)
  return (
    <div
      class="drop-zone"
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        depth.current += 1
        setOver(true)
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        depth.current = 0
        setOver(false)
        onFiles([...(event.dataTransfer?.files ?? [])])
      }}
    >
      {children}
      {over && (
        <div class="drop-zone__overlay" aria-hidden="true">
          <p class="drop-zone__panel">
            <span class="drop-zone__title">{t('composer.drop')}</span>
            <span class="drop-zone__hint">{t('composer.dropHint')}</span>
          </p>
        </div>
      )}
    </div>
  )
}
