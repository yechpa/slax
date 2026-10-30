/**
 * File uploads: POST /api/v1/files (multipart `file`, `channel_id`), through
 * XMLHttpRequest because fetch cannot report upload progress. Same session rules as
 * the API client (cookie, X-XSRF-TOKEN, one retry after a 419) and the same errors
 * (`ApiError`, with the server's `reason` for `file_rejected`).
 *
 * The server scans the file before answering, so "all bytes sent" is followed by a
 * wait: `onProgress(1)` then the answer.
 */
import { ApiError, apiPath, ensureCsrfCookie, failure, noteOffline, noteOnline, parseJson, xsrfToken } from './client.ts'
import type { FileInfo } from './types.ts'

export interface Upload {
  promise: Promise<FileInfo>
  /** Stops the transfer; the promise rejects with ApiError `aborted`. */
  abort(): void
}

export type UploadFn = (file: File, channelId: number, onProgress: (fraction: number) => void) => Upload

export const uploadFile: UploadFn = (file, channelId, onProgress) => {
  let current: XMLHttpRequest | null = null
  let aborted = false

  const attempt = (): Promise<{ status: number; text: string; retryAfter: string | null }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      current = xhr
      xhr.open('POST', apiPath('/files'))
      xhr.withCredentials = true
      xhr.setRequestHeader('Accept', 'application/json')
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
      const token = xsrfToken()
      if (token) xhr.setRequestHeader('X-XSRF-TOKEN', token)
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total))
      }
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText, retryAfter: xhr.getResponseHeader('Retry-After') })
      xhr.onerror = () => {
        noteOffline()
        reject(new ApiError(0, 'network'))
      }
      xhr.onabort = () => reject(new ApiError(0, 'aborted'))
      const form = new FormData()
      form.append('file', file, file.name)
      form.append('channel_id', String(channelId))
      xhr.send(form)
    })

  const run = async (): Promise<FileInfo> => {
    await ensureCsrfCookie()
    if (aborted) throw new ApiError(0, 'aborted')
    let response = await attempt()
    if (response.status === 419) {
      await ensureCsrfCookie(true)
      if (aborted) throw new ApiError(0, 'aborted')
      response = await attempt()
    }
    noteOnline()
    const body = parseJson(response.text)
    if (response.status >= 200 && response.status < 300) return body as FileInfo
    throw failure(response.status, body, response.retryAfter)
  }

  return {
    promise: run(),
    abort() {
      aborted = true
      current?.abort()
    },
  }
}
