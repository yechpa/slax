/**
 * Files waiting to go with a message, one tray per composer (`c:12` for a channel,
 * `t:40` for a thread). Each file is checked first (size, type, count: a refusal the
 * browser can predict sends nothing), then uploaded at once with its progress; the
 * message only carries the ids of the uploads that finished (`file_ids`).
 *
 * An upload can be cancelled (its transfer stops and the chip goes) or, after a failure,
 * retried with the same file. A failure is said in a toast and stays on its chip.
 */
import { signal, type Signal } from '@preact/signals'
import { isApiError } from '../api/client.ts'
import type { FileInfo } from '../api/types.ts'
import { uploadFile, type Upload, type UploadFn } from '../api/upload.ts'
import { MAX_FILES_PER_MESSAGE, checkFile, tooManyFilesText, uploadErrorCode, uploadErrorText } from '../lib/files.ts'
import { showToast } from './ui.ts'

export interface UploadItem {
  /** Local id, for the chip and its actions. */
  id: string
  channelId: number
  name: string
  size: number
  /** uploading: bytes on their way. scanning: all sent, the server checks it. */
  status: 'uploading' | 'scanning' | 'done' | 'failed'
  /** Bytes sent, 0..1. */
  progress: number
  /** Upload error code (see uploadErrorText) when failed. */
  error: string | null
  /** The server's file, once done. */
  file: FileInfo | null
}

export type Uploads = ReturnType<typeof createUploads>

export function createUploads({ upload = uploadFile }: { upload?: UploadFn } = {}) {
  const trays = new Map<string, Signal<UploadItem[]>>()
  /** The browser's File of each item (for a retry), and its transfer while it runs. */
  const sources = new Map<string, File>()
  const running = new Map<string, Upload>()
  let next = 1

  function tray(key: string): Signal<UploadItem[]> {
    let entry = trays.get(key)
    if (!entry) {
      entry = signal<UploadItem[]>([])
      trays.set(key, entry)
    }
    return entry
  }

  function patch(key: string, id: string, change: Partial<UploadItem>): void {
    const list = tray(key)
    if (!list.peek().some((item) => item.id === id)) return
    list.value = list.peek().map((item) => (item.id === id ? { ...item, ...change } : item))
  }

  function start(key: string, item: UploadItem): void {
    const source = sources.get(item.id)
    if (!source) return
    const transfer = upload(source, item.channelId, (fraction) => {
      patch(key, item.id, fraction >= 1 ? { progress: 1, status: 'scanning' } : { progress: fraction })
    })
    running.set(item.id, transfer)
    transfer.promise.then(
      (file) => {
        if (running.get(item.id) !== transfer) return
        running.delete(item.id)
        patch(key, item.id, { status: 'done', progress: 1, file })
      },
      (error: unknown) => {
        if (running.get(item.id) !== transfer) return
        running.delete(item.id)
        if (isApiError(error, 'aborted')) return
        const code = isApiError(error) ? uploadErrorCode(error) : 'generic'
        patch(key, item.id, { status: 'failed', error: code })
        // A 429 already has its own toast, with the delay.
        if (code !== 'rate_limited') showToast({ tone: 'error', text: uploadErrorText(code, item.name), key: `upload:${item.id}` })
      },
    )
  }

  /**
   * Checks and starts uploading `files` for this composer. Returns what was refused
   * before sending anything (translated sentences); the rest is on its way.
   */
  function add(key: string, channelId: number, files: readonly File[]): string[] {
    const problems: string[] = []
    const list = tray(key)
    let room = MAX_FILES_PER_MESSAGE - list.peek().length
    const added: UploadItem[] = []
    let refusedForCount = false
    for (const file of files) {
      const check = checkFile(file)
      if (check) {
        problems.push(uploadErrorText(check, file.name))
        continue
      }
      if (room <= 0) {
        refusedForCount = true
        continue
      }
      room -= 1
      const id = `u${next++}`
      sources.set(id, file)
      added.push({ id, channelId, name: file.name, size: file.size, status: 'uploading', progress: 0, error: null, file: null })
    }
    if (refusedForCount) problems.push(tooManyFilesText())
    if (added.length > 0) {
      list.value = [...list.peek(), ...added]
      for (const item of added) start(key, item)
    }
    return problems
  }

  /** Stops an upload (or drops a finished or failed one) and removes its chip. */
  function cancel(key: string, id: string): void {
    const transfer = running.get(id)
    running.delete(id)
    transfer?.abort()
    sources.delete(id)
    const list = tray(key)
    if (list.peek().some((item) => item.id === id)) list.value = list.peek().filter((item) => item.id !== id)
  }

  function retry(key: string, id: string): void {
    const item = tray(key).peek().find((i) => i.id === id)
    if (!item || item.status !== 'failed') return
    patch(key, id, { status: 'uploading', progress: 0, error: null })
    start(key, { ...item, status: 'uploading', progress: 0, error: null })
  }

  /** The files ready to go with the next message. */
  const attached = (key: string): FileInfo[] =>
    tray(key)
      .peek()
      .flatMap((item) => (item.status === 'done' && item.file ? [item.file] : []))

  /** Still sending or being checked: the message waits. */
  const busy = (key: string) => tray(key).peek().some((item) => item.status === 'uploading' || item.status === 'scanning')

  /** The message went: its files leave the tray (failed ones stay, to retry or remove). */
  function clearAttached(key: string): void {
    const list = tray(key)
    const keep = list.peek().filter((item) => item.status !== 'done')
    for (const item of list.peek()) if (item.status === 'done') sources.delete(item.id)
    if (keep.length !== list.peek().length) list.value = keep
  }

  function stop(): void {
    for (const transfer of running.values()) transfer.abort()
    running.clear()
    sources.clear()
    trays.clear()
  }

  return { tray, add, cancel, retry, attached, busy, clearAttached, stop }
}
