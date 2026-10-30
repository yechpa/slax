/**
 * The real application, fed with fixtures instead of a server: a stand-in `fetch` that
 * answers the few API routes the screens need, and a realtime client that never
 * delivers anything. Used by app-preview.html for review screenshots only (it is part
 * of the design-system build, never of the production one).
 */
import { signal } from '@preact/signals'
import type { Channel, Me, Message, UserSummary } from '../api/types.ts'
import type { Realtime } from '../realtime/echo.ts'

const ALICE: UserSummary = { id: 1, name: 'Alice Martin', avatar_url: null }
const DANA: UserSummary = { id: 2, name: 'dana', avatar_url: null }
const NOAM: UserSummary = { id: 3, name: 'נעם', avatar_url: null }
const ME: Me = { ...ALICE, email: 'alice@example.test', locale: 'en', theme: 'console', is_admin: false, workspace_id: 1 }

const base = new Date()
const at = (daysAgo: number, hh: number, mm: number) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() - daysAgo, hh, mm).toISOString()

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

const general: Message[] = [
  message(DANA, 1, 'Release notes for v1.4 are in the shared doc. Ping me if something is missing.', at(1, 16, 20)),
  message(ALICE, 1, 'Thanks! Reading them now.', at(1, 16, 23)),
  message(NOAM, 1, `מעולה. אני בודק את ה־metrics ב־Grafana: ${GRAFANA}`, at(0, 9, 38), { edited_at: at(0, 9, 39) }),
  message(NOAM, 1, 'הכול ירוק 🚀', at(0, 9, 39)),
  message(DANA, 1, 'k3s deploy went through, everything is green.', at(0, 9, 42)),
  message(ALICE, 1, 'Great work @dana and @נעם 🎉', at(0, 9, 44)),
]
const lastRead = general[general.length - 1].id
general.push(
  { id: nextId++, channel_id: 1, parent_id: null, created_at: at(0, 9, 45), reply_count: 0, last_reply_at: null, deleted: true },
  message(DANA, 1, 'Can someone review PR #128 before lunch? make test passes locally.', at(0, 9, 47)),
  message(NOAM, 1, 'אני על זה. Looking at the diff now.', at(0, 9, 49)),
  message(NOAM, 1, 'Two small comments, otherwise LGTM.', at(0, 9, 51)),
)

const channels: Channel[] = [
  room(1, 'general', 'Announcements and everything that fits nowhere else', { member_count: 12, last_read_message_id: lastRead, unread_count: 3 }),
  room(2, 'ingenierie', 'Engineering', { unread_count: 3 }),
  room(5, 'ops-oncall', 'Pager rotation', { kind: 'private', unread_count: 128, member_count: 4 }),
  room(3, 'random', 'Off-topic chatter'),
  room(4, 'securite', 'Security', { is_member: false }),
  { ...room(6, '', null), kind: 'dm', name: null, member_count: 2, members: [ALICE, DANA] },
  { ...room(7, '', null), kind: 'dm', name: null, member_count: 2, members: [ALICE, NOAM], unread_count: 1 },
  { ...room(8, '', null), kind: 'group_dm', name: null, member_count: 3, members: [ALICE, DANA, NOAM] },
]

function room(id: number, name: string, topic: string | null, extra: Partial<Channel> = {}): Channel {
  return { id, kind: 'public', name, topic, is_member: true, member_count: 8, last_read_message_id: null, unread_count: 0, ...extra }
}

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export function installFixtureServer({ signedIn }: { signedIn: boolean }): void {
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input), location.href)
    const path = url.pathname
    if (path === '/api/v1/me') return signedIn ? json(ME) : json({ message: 'Unauthenticated.' }, 401)
    if (path === '/api/v1/channels') return json(channels)
    const list = /^\/api\/v1\/channels\/(\d+)\/messages$/.exec(path)
    if (list) {
      const id = Number(list[1])
      const data = id === 1 ? general : id === 4 ? [message(NOAM, 4, 'Rotated the Turnstile keys.', at(0, 8, 12))] : []
      return json({ data, has_more: false })
    }
    return json(undefined, 204)
  }
}

/** Connected, silent. */
export const fixtureRealtime: Realtime = {
  state: signal('connected'),
  subscribe: () => () => undefined,
  whisper: () => undefined,
  subscribePresence: () => () => undefined,
  onReconnect: () => () => undefined,
  disconnect: () => undefined,
}
