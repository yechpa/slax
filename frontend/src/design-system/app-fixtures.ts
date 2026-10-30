/**
 * The real application, fed with fixtures instead of a server: a stand-in `fetch` that
 * answers the API routes the screens need, a stand-in XMLHttpRequest for uploads (one
 * finishes, one stays at 45 %, an archive is refused), and a realtime client that says
 * who is connected and that dana is typing. Used by app-preview.html for review
 * screenshots only (it is part of the design-system build, never of the production one).
 */
import { signal } from '@preact/signals'
import type { AdminStatus, AuditPage, Channel, ChannelMember, FileInfo, Me, Message, ModeratedUser, PresenceState, UserSummary } from '../api/types.ts'
import type { Realtime } from '../realtime/echo.ts'

const ALICE: UserSummary = { id: 1, name: 'Alice Martin', avatar_url: null }
const DANA: UserSummary = { id: 2, name: 'dana', avatar_url: null }
const NOAM: UserSummary = { id: 3, name: 'נעם', avatar_url: null }
const PEOPLE: UserSummary[] = [
  DANA,
  NOAM,
  { id: 4, name: 'Daniel Cohen', avatar_url: null },
  { id: 5, name: 'Dalia Mizrahi', avatar_url: null },
  { id: 6, name: 'Sam Taylor', avatar_url: null },
  { id: 7, name: 'Élodie Bernard', avatar_url: null },
]
const PRESENCE: Record<number, PresenceState> = { 1: 'online', 2: 'online', 3: 'away', 4: 'offline', 5: 'online', 6: 'away', 7: 'offline' }
const ME: Me = { ...ALICE, email: 'alice@example.test', locale: 'en', theme: 'console', is_admin: false, workspace_id: 1 }

const base = new Date()
const at = (daysAgo: number, hh: number, mm: number) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() - daysAgo, hh, mm).toISOString()

/** A small phosphor-style chart, inline: the preview needs no image file nor network. */
const CHART =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#0b0f0d"/>` +
      `<g stroke="#1b2a23" stroke-width="1">${[60, 120, 180, 240, 300].map((y) => `<line x1="40" y1="${y}" x2="620" y2="${y}"/>`).join('')}</g>` +
      `<polyline fill="none" stroke="#4ade80" stroke-width="4" points="40,250 110,230 180,240 250,180 320,190 390,120 460,140 530,90 600,100"/>` +
      `<polyline fill="none" stroke="#facc15" stroke-width="3" stroke-dasharray="8 6" points="40,300 140,290 240,295 340,270 440,275 540,250 600,255"/>` +
      `<text x="40" y="40" fill="#86efac" font-family="monospace" font-size="22">k3s p95 latency · 1h</text></svg>`,
  )

const file = (id: number, name: string, mime: string, size: number, kind: string, url?: string): FileInfo => ({
  id,
  name,
  mime,
  size,
  kind,
  download_url: url ?? `/api/v1/files/${id}/download`,
})

let nextId = 1
function message(user: UserSummary, channelId: number, body: string, created: string, extra: Partial<Message> = {}): Message {
  const id = nextId++
  return {
    id,
    channel_id: channelId,
    parent_id: null,
    created_at: created,
    reply_count: 0,
    last_reply_at: null,
    deleted: false,
    client_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    user,
    body,
    edited_at: null,
    reactions: [],
    files: [],
    ...extra,
  } as Message
}

const GRAFANA = 'https://grafana.slax.dev/d/k3s?from=now-1h'
const reacted = (emoji: string, ids: number[]) => ({ emoji, count: ids.length, reacted_by_me: ids.includes(ALICE.id), user_ids: ids })

const general: Message[] = [
  message(DANA, 1, 'Release notes for v1.4 are in the shared doc. Ping me if something is missing.', at(1, 16, 20), {
    reactions: [reacted('👍', [1, 3, 4]), reacted('🎉', [3])],
  }),
  message(ALICE, 1, 'Thanks! Reading them now.', at(1, 16, 23)),
]
const threadParent = message(NOAM, 1, `מעולה. אני בודק את ה־metrics ב־Grafana: ${GRAFANA}`, at(0, 9, 38), {
  edited_at: at(0, 9, 39),
  reply_count: 3,
  last_reply_at: at(0, 9, 52),
})
general.push(
  threadParent,
  message(NOAM, 1, 'הכול ירוק 🚀', at(0, 9, 39), { reactions: [reacted('🚀', [2, 1])] }),
  message(DANA, 1, 'k3s deploy went through, everything is green.', at(0, 9, 42)),
  message(ALICE, 1, 'Great work @dana and @נעם 🎉', at(0, 9, 44)),
)
const lastRead = general[general.length - 1].id
const deletedParent: Message = { id: nextId++, channel_id: 1, parent_id: null, created_at: at(0, 9, 45), reply_count: 2, last_reply_at: at(0, 9, 50), deleted: true }
general.push(
  deletedParent,
  message(DANA, 1, 'Can someone review PR #128 before lunch? make test passes locally.', at(0, 9, 47), {
    files: [file(901, 'pr-128-review.pdf', 'application/pdf', 245_312, 'pdf')],
  }),
  message(NOAM, 1, 'אני על זה. Looking at the diff now.', at(0, 9, 49)),
  message(NOAM, 1, '', at(0, 9, 50), {
    files: [file(902, 'grafana-k3s.png', 'image/png', 84_210, 'image', CHART), file(903, 'metrics-2026-10.zip', 'application/zip', 1_284_000, 'other')],
  }),
  message(NOAM, 1, 'Two small comments, otherwise LGTM.', at(0, 9, 51)),
)

const replies: Record<number, Message[]> = {
  [threadParent.id]: [
    message(DANA, 1, 'Nice, p95 is flat since the deploy.', at(0, 9, 40), { parent_id: threadParent.id }),
    message(ALICE, 1, 'Agreed. Shipping the same config to staging.', at(0, 9, 47), { parent_id: threadParent.id, reactions: [reacted('✅', [3])] }),
    message(NOAM, 1, 'תודה! 🙏 אעדכן את ה־dashboard.', at(0, 9, 52), { parent_id: threadParent.id }),
  ],
  [deletedParent.id]: [
    message(DANA, 1, 'Was that the old staging URL?', at(0, 9, 46), { parent_id: deletedParent.id }),
    message(ALICE, 1, 'Yes, I removed it. The new one is pinned.', at(0, 9, 50), { parent_id: deletedParent.id }),
  ],
}

const channels: Channel[] = [
  room(1, 'general', 'Announcements and everything that fits nowhere else', { member_count: 12, last_read_message_id: lastRead, unread_count: 3 }),
  room(2, 'ingenierie', 'Engineering', { unread_count: 3 }),
  room(5, 'ops-oncall', 'Pager rotation', { kind: 'private', unread_count: 128, member_count: 4 }),
  room(3, 'random', 'Off-topic chatter', { locked: true }),
  room(4, 'securite', 'Security', { is_member: false }),
  room(9, 'design', 'Mockups, fonts and the green-bar paper', { is_member: false, member_count: 5 }),
  { ...room(6, '', null), kind: 'dm', name: null, member_count: 2, members: [ALICE, DANA] },
  { ...room(7, '', null), kind: 'dm', name: null, member_count: 2, members: [ALICE, NOAM], unread_count: 1 },
  { ...room(8, '', null), kind: 'group_dm', name: null, member_count: 3, members: [ALICE, DANA, NOAM] },
]

/** The 12 members of #general, owners first, as the API orders them. */
const members: ChannelMember[] = [
  { ...ALICE, role: 'owner' },
  { ...DANA, role: 'owner' },
  ...[PEOPLE[3], PEOPLE[2], PEOPLE[5], { id: 8, name: 'Hugo Lefèvre', avatar_url: null }, { id: 9, name: 'Maya Ben-David', avatar_url: null }, NOAM, { id: 10, name: 'Omer Levi', avatar_url: null }, PEOPLE[4], { id: 11, name: 'Yael Shapiro', avatar_url: null }, { id: 12, name: 'Zoé Martin', avatar_url: null }].map(
    (person) => ({ ...person, role: 'member' as const }),
  ),
]

function room(id: number, name: string, topic: string | null, extra: Partial<Channel> = {}): Channel {
  return { id, kind: 'public', name, topic, is_member: true, member_count: 8, last_read_message_id: null, unread_count: 0, ...extra }
}

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The administration screens (?admin=1). */
const ADMIN_STATUS: AdminStatus = {
  environment: 'Dev',
  checked_at: at(0, 9, 41),
  services: [
    { name: 'database', status: 'ok', latency_ms: 3 },
    { name: 'redis', status: 'ok', latency_ms: 1 },
    { name: 'reverb', status: 'ok', latency_ms: 6 },
    { name: 'scanner', status: 'degraded', latency_ms: 2004 },
    { name: 's3', status: 'ok', latency_ms: 41 },
  ],
}
const AUDIT: AuditPage = {
  page: 1,
  per_page: 50,
  has_more: true,
  data: [
    { id: 9, action: 'channel.locked', created_at: at(0, 9, 38), ip: '100.64.0.7', actor: ALICE, target: { type: 'channel', id: 3, label: 'random' } },
    { id: 8, action: 'message.moderated_delete', created_at: at(0, 9, 31), ip: '100.64.0.7', actor: ALICE, target: { type: 'message', id: 1204, label: null } },
    { id: 7, action: 'user.banned', created_at: at(0, 9, 30), ip: '100.64.0.7', actor: ALICE, target: { type: 'user', id: 44, label: 'Spam Bot 3000' } },
    { id: 6, action: 'auth.sign_in_failed.invalid_token', created_at: at(0, 8, 2), ip: '203.0.113.9', actor: null, target: null },
    { id: 5, action: 'message.send_refused', created_at: at(0, 7, 55), ip: '198.51.100.23', actor: { id: 12, name: 'Zoé Martin' }, target: { type: 'channel', id: 3, label: 'random' } },
    { id: 4, action: 'demo.reset', created_at: at(0, 3, 0), ip: null, actor: null, target: null },
  ],
}
const BANNED: ModeratedUser[] = [{ id: 44, name: 'Spam Bot 3000', avatar_url: null, banned: true, banned_at: at(0, 9, 30) }]

export function installFixtureServer({ signedIn, admin = false }: { signedIn: boolean; admin?: boolean }): void {
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input), location.href)
    const path = url.pathname
    if (path === '/api/v1/me') return signedIn ? json({ ...ME, is_admin: admin }) : json({ message: 'Unauthenticated.' }, 401)
    if (path === '/api/v1/admin/status') return admin ? json(ADMIN_STATUS) : json({ message: 'Forbidden' }, 403)
    if (path === '/api/v1/admin/audit') return admin ? json(AUDIT) : json({ message: 'Forbidden' }, 403)
    if (path === '/api/v1/admin/channels')
      return admin
        ? json({ data: channels.filter((c) => c.kind === 'public' || c.kind === 'private').map((c) => ({ id: c.id, name: c.name, kind: c.kind, locked: c.locked ?? false, member_count: c.member_count })) })
        : json({ message: 'Forbidden' }, 403)
    if (path === '/api/v1/admin/users/banned') return admin ? json({ data: BANNED }) : json({ message: 'Forbidden' }, 403)
    if (path === '/api/v1/channels') return json(channels)
    if (path === '/api/v1/users') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      return json(PEOPLE.filter((p) => p.name.toLowerCase().includes(q)))
    }
    if (path === '/api/v1/presence') return json(Object.fromEntries(url.searchParams.getAll('user_ids[]').map((id) => [id, PRESENCE[Number(id)] ?? 'offline'])))
    if (/^\/api\/v1\/channels\/\d+\/members$/.test(path)) return json(members)
    const thread = /^\/api\/v1\/messages\/(\d+)\/replies$/.exec(path)
    if (thread) {
      const id = Number(thread[1])
      return json({ parent: general.find((m) => m.id === id), data: replies[id] ?? [], has_more: false })
    }
    const list = /^\/api\/v1\/channels\/(\d+)\/messages$/.exec(path)
    if (list) {
      const id = Number(list[1])
      const data = id === 1 ? general : id === 4 ? [message(NOAM, 4, 'Rotated the Turnstile keys.', at(0, 8, 12))] : []
      return json({ data, has_more: false })
    }
    return json(undefined, 204)
  }
  globalThis.XMLHttpRequest = FixtureUpload as unknown as typeof XMLHttpRequest
}

/**
 * Uploads without a server: a name with "archive" is refused as an encrypted zip, one with
 * "diagram" stays at 45 %, anything else is accepted.
 */
class FixtureUpload {
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  status = 0
  responseText = ''
  withCredentials = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  open() {}
  setRequestHeader() {}
  getResponseHeader() {
    return null
  }
  abort() {
    this.onabort?.()
  }
  send(form: FormData) {
    const sent = form.get('file') as File
    const progress = (loaded: number) => this.upload.onprogress?.({ lengthComputable: true, loaded, total: 100 })
    setTimeout(() => {
      if (sent.name.includes('diagram')) return progress(45)
      progress(100)
      if (sent.name.includes('archive')) {
        this.status = 422
        this.responseText = JSON.stringify({ error: 'file_rejected', reason: 'zip_encrypted' })
      } else {
        this.status = 201
        this.responseText = JSON.stringify(file(950, sent.name, sent.type, sent.size, 'pdf'))
      }
      this.onload?.()
    }, 30)
  }
}

/** Connected; says who is around, and that dana is typing in #general. */
export const fixtureRealtime: Realtime = {
  state: signal('connected'),
  subscribe: (name, handlers) => {
    if (name !== 'private-channel.1') return () => undefined
    const typing = () => handlers['client-typing']?.({ typing: true, parent_id: null }, { user_id: String(DANA.id) })
    const first = setTimeout(typing, 50)
    const again = setInterval(typing, 2000)
    return () => {
      clearTimeout(first)
      clearInterval(again)
    }
  },
  whisper: () => undefined,
  subscribePresence: (_name, listener) => {
    setTimeout(() => listener.members([ALICE, DANA, NOAM, PEOPLE[3]]), 0)
    return () => undefined
  },
  onReconnect: () => () => undefined,
  disconnect: () => undefined,
}
