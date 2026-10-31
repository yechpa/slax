/**
 * A message's files: images as a lazy preview (opening the full file), the others (PDF,
 * text, zip) as file chips. Every link goes through `download_url`, which checks access
 * and redirects to a short-lived URL; a preview that cannot load falls back to a chip.
 */
import { useState } from 'preact/hooks'
import type { FileInfo } from '../api/types.ts'
import { FileChip } from './ui/FileChip.tsx'

export function Attachments({ files }: { files: readonly FileInfo[] }) {
  if (files.length === 0) return null
  return (
    <>
      {files.map((file) => (file.kind === 'image' ? <ImagePreview key={file.id} file={file} /> : <FileChip key={file.id} name={file.name} bytes={file.size} href={file.download_url} />))}
    </>
  )
}

function ImagePreview({ file }: { file: FileInfo }) {
  const [broken, setBroken] = useState(false)
  if (broken) return <FileChip name={file.name} bytes={file.size} href={file.download_url} />
  return (
    <a class="attachment-image" href={file.download_url} target="_blank" rel="noopener" title={file.name}>
      <img class="attachment-image__img" src={file.download_url} alt={file.name} loading="lazy" decoding="async" onError={() => setBroken(true)} />
    </a>
  )
}
