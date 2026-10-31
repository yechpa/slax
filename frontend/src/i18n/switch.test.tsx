import { afterEach, describe, expect, it } from 'vitest'
import { setLocale, type Locale } from './index.ts'
import { openDialog, realtimeDown, resetUi, showToast } from '../store/ui.ts'
import { DANA, NOAM, channel, live, tombstone } from '../test/fixtures.ts'
import type { FakeHandler } from '../test/fakes.ts'
import { mountApp, settle, type Mounted } from '../test/mountApp.tsx'

let app: Mounted | null = null
afterEach(() => {
  app?.cleanup()
  app = null
  resetUi()
})

const routes = () => ({
  'GET /api/v1/channels': () => ({
    body: [
      channel(7, { name: 'general', topic: 'News', member_count: 12, unread_count: 0 }),
      channel(8, { name: 'random', is_member: false }),
      channel(9, { kind: 'dm', name: null, members: [{ id: 1, name: 'Alice', avatar_url: null }, DANA], unread_count: 3 }),
    ],
  }),
  'GET /api/v1/channels/8/messages': () => ({ body: { data: [live(20, { channel_id: 8 })], has_more: false } }),
  'GET /api/v1/channels/7/members': () => ({ body: [{ id: 1, name: 'Alice', avatar_url: null, role: 'owner' }, { ...DANA, role: 'member' }] }),
  'GET /api/v1/messages/1/replies': () => ({ body: { parent: live(1, { reply_count: 2 }), data: [live(11, { parent_id: 1 }), live(12, { parent_id: 1 })], has_more: false } }),
  'GET /api/v1/channels/7/messages': () => ({
    body: {
      data: [
        live(1, { reply_count: 2, last_reply_at: '2026-10-30T09:05:00.000Z', reactions: [{ emoji: '👍', count: 2, reacted_by_me: false, user_ids: [2, 3] }] }),
        live(2, { edited_at: '2026-10-30T09:06:00.000Z', user: NOAM, files: [{ id: 5, name: 'plan.pdf', mime: 'application/pdf', size: 2048, kind: 'pdf', download_url: '/api/v1/files/5/download' }] }),
        tombstone(3),
      ],
      has_more: true,
    },
  }),
})

type Scene = { path: string; signedOut?: boolean; dialog?: 'create-channel' | 'browse-channels' | 'new-message'; details?: boolean }

/** The whole page as the person sees it (ids from useId are positional: the same in both). */
async function page(scene: Scene, locale: Locale, switchTo?: Locale): Promise<string> {
  const signedOut: Record<string, FakeHandler> = scene.signedOut ? { 'GET /api/v1/me': () => ({ status: 401, body: { message: 'Unauthenticated.' } }) } : {}
  app = await mountApp({ ...routes(), ...signedOut }, scene.path, { locale })
  if (!scene.signedOut) {
    app.realtime.emitWhisper('private-channel.7', 'client-typing', { typing: true, parent_id: null }, DANA.id)
    realtimeDown.value = true
    showToast({ tone: 'success', text: 'kept as written', key: 'x' })
    if (scene.dialog) openDialog.value = scene.dialog
    if (scene.details) app.host.querySelector<HTMLButtonElement>('.channel-header__details')!.click()
  }
  await settle()
  if (switchTo) {
    setLocale(switchTo)
    await settle()
  }
  const html = app.host.innerHTML
  app.cleanup()
  app = null
  return html
}

/** Where two renderings differ, tag by tag (a readable failure, unlike two long strings). */
function differences(switched: string, fresh: string): string[] {
  const a = switched.split('>')
  const b = fresh.split('>')
  const found: string[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) found.push(`switched: ${a[i]} | opened: ${b[i]}`)
  return found
}

/**
 * A component whose props do not change is not re-rendered by its parent (@preact/signals
 * skips it when it reads signals or holds state): unless it calls useLocale(), it would keep
 * the previous language. Each scene is rendered in one language and switched, then opened
 * afresh in the other: both must be the same page.
 */
const scenes: Scene[] = [
  { path: '/c/7' },
  { path: '/c/7/t/1' },
  { path: '/c/8' },
  { path: '/admin' },
  { path: '/c/7', dialog: 'create-channel' },
  { path: '/c/7', dialog: 'browse-channels' },
  { path: '/c/7', dialog: 'new-message' },
  { path: '/c/7', details: true },
  { path: '/', signedOut: true },
]

// Each case mounts the whole app four times: generous, so a busy CI runner cannot flake it.
describe('switching the language', { timeout: 20_000 }, () => {
  for (const scene of scenes) {
    it(`re-renders every string (${JSON.stringify(scene)}), as a page opened in that language`, async () => {
      for (const [from, to] of [
        ['en', 'fr'],
        ['fr', 'he'],
      ] as const) {
        const switched = await page(scene, from, to)
        const fresh = await page(scene, to)
        expect(differences(switched, fresh), `${from} -> ${to}`).toEqual([])
      }
    })
  }
})
