import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../api/client.ts'
import type { FileInfo } from '../api/types.ts'
import type { Upload, UploadFn } from '../api/upload.ts'
import { setLocale } from '../i18n/index.ts'
import { uploadErrorCode, uploadErrorText } from '../lib/files.ts'
import { flush } from '../test/fakes.ts'
import { resetUi, toasts } from './ui.ts'
import { createUploads } from './uploads.ts'

/** An upload the test drives by hand: progress, success, failure. */
interface Controlled {
  file: File
  channelId: number
  progress: (fraction: number) => void
  resolve: (info: FileInfo) => void
  reject: (error: unknown) => void
  aborted: boolean
}

function controlledUploads() {
  const started: Controlled[] = []
  const upload: UploadFn = (file, channelId, onProgress) => {
    let resolve!: (info: FileInfo) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<FileInfo>((res, rej) => {
      resolve = res
      reject = rej
    })
    const entry: Controlled = { file, channelId, progress: onProgress, resolve, reject, aborted: false }
    started.push(entry)
    const handle: Upload = {
      promise,
      abort() {
        entry.aborted = true
        reject(new ApiError(0, 'aborted'))
      },
    }
    return handle
  }
  return { started, upload }
}

const file = (name: string, size: number, type = '') => new File([new Uint8Array(size)], name, { type })
const info = (id: number, name: string): FileInfo => ({ id, name, mime: 'image/png', size: 3, kind: 'image', download_url: `/api/v1/files/${id}/download` })
const KEY = 'c:7'
/** Without the isolates t() puts around inserted values. */
const plain = (text: string) => text.replace(/[\u2068\u2069]/g, '')
const uploadErrorTextFor = (code: string) => uploadErrorText(code, 'report.pdf')
const codeOf = (error: ApiError) => uploadErrorCode(error)

beforeEach(() => setLocale('en'))
afterEach(() => resetUi())

describe('uploads', () => {
  it('goes back to uploading when the bytes are sent again (a 419 re-send), then ends done', async () => {
    const { started, upload } = controlledUploads()
    const uploads = createUploads({ upload })
    const tray = uploads.tray(KEY)
    uploads.add(KEY, 7, [file('report.pdf', 3, 'application/pdf')])
    started[0].progress(1)
    expect(tray.value[0]).toMatchObject({ status: 'scanning', progress: 1 })
    // The session token had expired: the same bytes go again from the start.
    started[0].progress(0)
    expect(tray.value[0]).toMatchObject({ status: 'uploading', progress: 0 })
    expect(uploads.busy(KEY)).toBe(true)
    started[0].progress(0.5)
    expect(tray.value[0]).toMatchObject({ status: 'uploading', progress: 0.5 })
    started[0].progress(1)
    expect(tray.value[0]).toMatchObject({ status: 'scanning', progress: 1 })
    started[0].resolve(info(4, 'report.pdf'))
    await flush()
    expect(tray.value[0]).toMatchObject({ status: 'done', file: { id: 4 } })
  })

  it('upload_progress_cancel_and_retry', async () => {
    const { started, upload } = controlledUploads()
    const uploads = createUploads({ upload })
    const tray = uploads.tray(KEY)

    expect(uploads.add(KEY, 7, [file('a.png', 3, 'image/png'), file('b.pdf', 5, 'application/pdf')])).toEqual([])
    expect(started.map((s) => [s.file.name, s.channelId])).toEqual([
      ['a.png', 7],
      ['b.pdf', 7],
    ])
    expect(tray.value.map((i) => [i.name, i.status, i.progress])).toEqual([
      ['a.png', 'uploading', 0],
      ['b.pdf', 'uploading', 0],
    ])
    expect(uploads.busy(KEY)).toBe(true)

    // Progress, then every byte sent: the server is scanning.
    started[0].progress(0.4)
    expect(tray.value[0].progress).toBe(0.4)
    started[0].progress(1)
    expect(tray.value[0].status).toBe('scanning')
    started[0].resolve(info(31, 'a.png'))
    await flush()
    expect(tray.value[0]).toMatchObject({ status: 'done', file: info(31, 'a.png') })

    // Cancel: the transfer stops and the chip goes, without an error toast.
    uploads.cancel(KEY, tray.value[1].id)
    await flush()
    expect(started[1].aborted).toBe(true)
    expect(tray.value.map((i) => i.name)).toEqual(['a.png'])
    expect(toasts.value).toEqual([])
    expect(uploads.busy(KEY)).toBe(false)

    // A failure keeps the chip (failed, with its reason), and Retry sends the same file again.
    uploads.add(KEY, 7, [file('c.txt', 4, 'text/plain')])
    started[2].reject(new ApiError(503, 'scanner_unavailable'))
    await flush()
    const failed = tray.value[1]
    expect(failed).toMatchObject({ name: 'c.txt', status: 'failed', error: 'scanner_unavailable' })
    expect(toasts.value.map((t) => plain(t.text))).toEqual(["Files can't be checked right now (c.txt). Try again in a moment."])

    uploads.retry(KEY, failed.id)
    expect(started).toHaveLength(4)
    expect(started[3].file).toBe(started[2].file)
    expect(tray.value[1]).toMatchObject({ id: failed.id, status: 'uploading', progress: 0, error: null })
    started[3].resolve(info(32, 'c.txt'))
    await flush()
    expect(uploads.attached(KEY).map((f) => f.id)).toEqual([31, 32])

    // Sent: the attached files leave the tray.
    uploads.clearAttached(KEY)
    expect(tray.value).toEqual([])
  })

  it('checks size, type and count before any upload starts', () => {
    const { started, upload } = controlledUploads()
    const uploads = createUploads({ upload })

    const problems = uploads.add(KEY, 7, [
      file('huge.png', 10 * 1024 * 1024 + 1, 'image/png'),
      file('empty.txt', 0, 'text/plain'),
      file('tool.exe', 10, 'application/x-msdownload'),
      file('ok.zip', 10, 'application/zip'),
      file('notes', 10, ''),
    ])
    expect(problems.map(plain)).toEqual([
      'huge.png is larger than 10 MB.',
      'empty.txt is empty.',
      'tool.exe: this type of file is not accepted (images, PDF, text and zip only).',
    ])
    expect(started.map((s) => s.file.name)).toEqual(['ok.zip', 'notes'])

    // Ten at most per message, counting what is already in the tray.
    const more = uploads.add(
      KEY,
      7,
      Array.from({ length: 9 }, (_, i) => file(`p${i}.png`, 1, 'image/png')),
    )
    expect(more.map(plain)).toEqual(['10 files at most per message.'])
    expect(uploads.tray(KEY).value).toHaveLength(10)
  })

  it('upload_error_codes_are_translated', () => {
    const codes = [
      'too_large',
      'empty_file',
      'type_not_allowed',
      'extension_mismatch',
      'invalid_text',
      'zip_corrupt',
      'zip_encrypted',
      'zip_too_many_entries',
      'zip_unsafe_path',
      'zip_too_large',
      'zip_ratio_too_high',
      'quota_exceeded',
      'scanner_unavailable',
      'storage_unavailable',
      'rate_limited',
      'network',
      'rejected',
      'something_new',
    ]
    for (const locale of ['en', 'he', 'fr'] as const) {
      setLocale(locale)
      const texts = codes.map((code) => uploadErrorTextFor(code))
      for (const [index, text] of texts.entries()) {
        expect(text, `${locale} ${codes[index]}`).not.toMatch(/upload\.error|\{/)
        expect(text, `${locale} ${codes[index]}`).toContain('report.pdf')
      }
      // Each known code has its own sentence; an unknown one falls back to the generic.
      expect(new Set(texts.slice(0, -1)).size).toBe(codes.length - 1)
    }
    setLocale('en')
    // A body stopped for its size before the API saw it (413, or PHP's upload limit) is "too large".
    expect(codeOf(new ApiError(413, 'payload_too_large'))).toBe('too_large')
    expect(codeOf(new ApiError(422, 'validation', { fields: { file: ['The file failed to upload.'] } }))).toBe('too_large')
    expect(codeOf(new ApiError(422, 'file_rejected', { reason: 'zip_unsafe_path' }))).toBe('zip_unsafe_path')
    expect(codeOf(new ApiError(503, 'scanner_unavailable'))).toBe('scanner_unavailable')
  })
})
