import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientState } from './client.ts'
import { uploadFile } from './upload.ts'

/** A stand-in for XMLHttpRequest: each request answers with the next status, after its bytes "went". */
function fakeXhr(statuses: number[]) {
  const sent: string[] = []
  class FakeXhr {
    status = 0
    responseText = ''
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    withCredentials = false
    private headers = new Map<string, string>()
    open(method: string, url: string) {
      sent.push(`${method} ${url}`)
    }
    setRequestHeader(name: string, value: string) {
      this.headers.set(name, value)
    }
    getResponseHeader() {
      return null
    }
    abort() {
      this.onabort?.()
    }
    send() {
      const status = statuses.shift() ?? 500
      queueMicrotask(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent)
        this.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 } as ProgressEvent)
        this.status = status
        this.responseText = status === 201 ? JSON.stringify({ id: 4, name: 'a.txt' }) : JSON.stringify({ message: 'CSRF token mismatch.' })
        this.onload?.()
      })
    }
  }
  return { FakeXhr, sent }
}

beforeEach(() => {
  resetClientState()
  document.cookie = 'XSRF-TOKEN=token; path=/'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
})

describe('uploadFile', () => {
  it('says the bytes start over when a 419 makes it send them again', async () => {
    const { FakeXhr, sent } = fakeXhr([419, 201])
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const progress: number[] = []
    const info = await uploadFile(new File(['0123456789'], 'a.txt'), 7, (fraction) => progress.push(fraction)).promise
    expect(info).toMatchObject({ id: 4 })
    expect(sent).toEqual(['POST /api/v1/files', 'POST /api/v1/files'])
    expect(progress).toEqual([0.5, 1, 0, 0.5, 1])
  })
})
