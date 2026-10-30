import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileInfo } from '../api/types.ts'
import { ME, channel, live } from '../test/fixtures.ts'
import { key, mountApp, plain, settle, type Mounted } from '../test/mountApp.tsx'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
})

/** XMLHttpRequest for uploads: records each one and answers like the API (201 with the file). */
class FakeUpload {
  static opened: FakeUpload[] = []
  upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null }
  status = 0
  responseText = ''
  withCredentials = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  sent: FormData | null = null
  constructor() {
    FakeUpload.opened.push(this)
  }
  open() {}
  setRequestHeader() {}
  getResponseHeader() {
    return null
  }
  abort() {
    this.onabort?.()
  }
  send(form: FormData) {
    this.sent = form
    const file = form.get('file') as File
    queueMicrotask(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: file.size, total: file.size })
      this.status = 201
      this.responseText = JSON.stringify(uploaded(file.name, file.size))
      this.onload?.()
    })
  }
}

const uploaded = (name: string, size: number): FileInfo => ({ id: 77, name, mime: 'image/png', size, kind: 'image', download_url: '/api/v1/files/77/download' })

const routes = () => ({
  'GET /api/v1/channels': () => ({ body: [channel(7, { name: 'general' })] }),
  'GET /api/v1/channels/7/messages': () => ({ body: { data: [live(1, { body: 'hello' })], has_more: false } }),
})

/** Picks files through the composer's file input, as the dialog would. */
function pick(host: HTMLElement, files: File[]): void {
  const input = host.querySelector<HTMLInputElement>('.shell__footer .composer__picker')!
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('files in the composer', () => {
  it('composer_blocks_files_over_10mb_before_upload', async () => {
    FakeUpload.opened = []
    vi.stubGlobal('XMLHttpRequest', FakeUpload)
    app = await mountApp(routes(), '/c/7')
    const before = app.server.calls.length

    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge-screenshot.png', { type: 'image/png' })
    pick(app.host, [big])
    await settle()
    // Dropped on the channel: the same check.
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown }
    drop.dataTransfer = { types: ['Files'], files: [big] }
    app.host.querySelector('.message-list')!.dispatchEvent(drop)
    await settle()

    expect(FakeUpload.opened).toHaveLength(0)
    expect(app.server.calls.slice(before).filter((c) => c.path === '/api/v1/files')).toHaveLength(0)
    expect(app.host.querySelector('.composer .file-chip')).toBeNull()
    expect(plain(app.host.querySelector('.toast--error')?.textContent)).toContain('huge-screenshot.png is larger than 10 MB.')
  })

  it('file_only_message_can_be_sent', async () => {
    FakeUpload.opened = []
    vi.stubGlobal('XMLHttpRequest', FakeUpload)
    const r = {
      ...routes(),
      'POST /api/v1/channels/7/messages': ({ body }: { body: unknown }) => {
        const sent = body as { body: string; client_id: string; file_ids: number[] }
        return {
          status: 201,
          body: live(2, { body: sent.body, client_id: sent.client_id, user: { id: ME.id, name: ME.name, avatar_url: null }, files: [uploaded('chart.png', 3)] }),
        }
      },
    }
    app = await mountApp(r, '/c/7')
    const send = () => [...app!.host.querySelectorAll<HTMLButtonElement>('.shell__footer .btn--primary')].find((b) => b.textContent === 'Send')!
    expect(send().disabled).toBe(true)

    pick(app.host, [new File([new Uint8Array(3)], 'chart.png', { type: 'image/png' })])
    await settle()
    expect(FakeUpload.opened).toHaveLength(1)
    expect((FakeUpload.opened[0].sent!.get('channel_id') as string)).toBe('7')
    expect(app.host.querySelector('.composer .file-chip--ready')?.textContent).toContain('chart.png')

    // Nothing typed, a file ready: the message can go (Enter or Send).
    expect(send().disabled).toBe(false)
    key(app.host.querySelector('.shell__footer textarea')!, { key: 'Enter' })
    await settle()
    const post = app.server.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/channels/7/messages')
    expect(post?.body).toMatchObject({ body: '', file_ids: [77] })
    // Shown as an image with its name as the alternative text, and the tray is empty again.
    const image = app.host.querySelector<HTMLImageElement>('.message-list .attachment-image__img')
    expect(image?.getAttribute('alt')).toBe('chart.png')
    expect(image?.getAttribute('loading')).toBe('lazy')
    expect(app.host.querySelector('.composer .file-chip')).toBeNull()
    expect(send().disabled).toBe(true)
  })
})
