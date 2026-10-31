/**
 * Light load test (make load): simulated Slax clients against the e2e stack, with Node's own
 * fetch and WebSocket (no dependency). Each client is what a browser tab does, minus the page:
 *
 *   - signs in through the e2e stand-in for Google (CSRF cookie, POST /api/v1/auth/google/start
 *     with Turnstile's test token, the fake account chooser, the real callback): a session
 *     cookie, like a browser's;
 *   - opens a WebSocket to Reverb (Pusher protocol 7, through nginx at /app), authorizes its
 *     channels with POST /broadcasting/auth (session cookie + X-XSRF-TOKEN), subscribes to
 *     the test channel `private-channel.{id}` and the workspace presence channel, answers
 *     pings, and sends the presence heartbeat every 25 s as the app does;
 *   - some of them post messages over the REST API at a steady total rate.
 *
 * Every message carries a client_id; every client records when each one arrives. Latency is
 * from just before the POST to the arrival on each socket (one process, one clock). Output:
 * a JSON summary in $LOAD_OUT (and a short line on stdout).
 *
 * Environment (defaults: the full run of the brief): LOAD_CLIENTS=50, LOAD_SENDERS=25,
 * LOAD_RATE=10 (messages/s, all senders together), LOAD_SECONDS=120, LOAD_DRAIN_SECONDS=15,
 * LOAD_BASE_URL=http://localhost, LOAD_REVERB_KEY=slax-e2e-key, LOAD_OUT=/out/results.json.
 * A sender may post 30 messages a minute (the app's limit): LOAD_RATE / LOAD_SENDERS must
 * stay at or below 0.5.
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const env = (name, fallback) => process.env[name] ?? fallback
const CLIENTS = Number(env('LOAD_CLIENTS', 50))
const SENDERS = Number(env('LOAD_SENDERS', Math.min(25, CLIENTS)))
const RATE = Number(env('LOAD_RATE', 10))
const SECONDS = Number(env('LOAD_SECONDS', 120))
const DRAIN_SECONDS = Number(env('LOAD_DRAIN_SECONDS', 15))
const BASE = env('LOAD_BASE_URL', 'http://localhost')
const KEY = env('LOAD_REVERB_KEY', 'slax-e2e-key')
const OUT = env('LOAD_OUT', '/out/results.json')
const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'
const HEARTBEAT_MS = 25_000
/**
 * Every HTTP request (its answer and its body) is abandoned after this: a stuck one would
 * otherwise stall the run. LOAD_REQUEST_TIMEOUT_MS: for load.test.mjs only.
 */
const REQUEST_TIMEOUT_MS = Number(env('LOAD_REQUEST_TIMEOUT_MS', 10_000))

if (SENDERS > CLIENTS || RATE / SENDERS > 0.5) {
  console.error(`LOAD_RATE/LOAD_SENDERS must be <= 0.5 (the app allows 30 messages a minute per user) and LOAD_SENDERS <= LOAD_CLIENTS`)
  process.exit(2)
}

const now = () => performance.now()
/** Why a request (or reading its body) failed, in a few words. */
const failureReason = (error) => (error.name === 'TimeoutError' ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} s` : (error.cause?.code ?? error.message))
const round1 = (value) => Math.round(value * 10) / 10
/** What the test is doing (named when it fails). */
let phase = 'start'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** HTTP results by kind: count, errors (status >= 400 or network), latencies (ms). */
const http = {}
function record(kind, ms, ok) {
  const entry = (http[kind] ??= { count: 0, errors: 0, latencies: [] })
  entry.count += 1
  if (!ok) entry.errors += 1
  entry.latencies.push(ms)
}

/** A browser's cookies for one origin, enough for Laravel's session and XSRF cookies. */
class Jar {
  cookies = new Map()
  store(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '' || value === 'deleted'
      if (expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }
  xsrf() {
    const token = this.cookies.get('XSRF-TOKEN')
    return token === undefined ? undefined : decodeURIComponent(token)
  }
}

class Client {
  constructor(index) {
    this.index = index
    this.jar = new Jar()
    this.received = new Map() // client_id -> arrival time (ms)
    this.duplicates = 0
    this.closed = 0
    this.errors = []
  }

  async request(kind, method, path, body, { redirect = 'follow' } = {}) {
    const headers = { Accept: 'application/json', Referer: `${BASE}/`, Cookie: this.jar.header() }
    const xsrf = this.jar.xsrf()
    if (xsrf !== undefined) headers['X-XSRF-TOKEN'] = xsrf
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const started = now()
    let response
    try {
      response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      record(kind, now() - started, false)
      throw new Error(`[${phase}] ${method} ${path}: ${failureReason(error)}`)
    }
    this.jar.store(response)
    const ok = response.status < 400
    record(kind, now() - started, ok)
    if (!ok) throw new Error(`[${phase}] ${method} ${path}: HTTP ${response.status}`)
    return response
  }

  async json(kind, method, path, body) {
    const response = await this.request(kind, method, path, body)
    if (response.status === 204) return undefined
    // The body comes after the headers, under the same timeout: a failure there names its phase too.
    try {
      return await response.json()
    } catch (error) {
      throw new Error(`[${phase}] ${method} ${path}: ${failureReason(error)}`)
    }
  }

  async signIn() {
    await this.request('sign-in', 'GET', '/sanctum/csrf-cookie')
    const { redirect_url: url } = await this.json('sign-in', 'POST', '/api/v1/auth/google/start', { turnstile_token: TURNSTILE_TEST_TOKEN })
    const chooser = new URL(url, BASE)
    const approve = new URLSearchParams({
      state: chooser.searchParams.get('state'),
      nonce: chooser.searchParams.get('nonce'),
      email: `load-${process.pid}-${this.index}@example.test`,
      name: `Load ${this.index}`,
      email_verified: '1',
    })
    const back = await this.request('sign-in', 'GET', `/auth/e2e/google/approve?${approve}`, undefined, { redirect: 'manual' })
    const callback = new URL(back.headers.get('location'), BASE)
    const home = await this.request('sign-in', 'GET', `${callback.pathname}${callback.search}`, undefined, { redirect: 'manual' })
    const landing = home.headers.get('location') ?? ''
    if (landing.includes('auth_error')) throw new Error(`sign-in refused: ${landing}`)
    this.me = await this.json('api', 'GET', '/api/v1/me')
  }

  /** Opens the socket, subscribes to the channels; resolves once every subscription succeeded. */
  connect(channels) {
    return new Promise((resolve, reject) => {
      const pending = new Set(channels)
      const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/app/${KEY}?protocol=7&client=js&version=8.4.0&flash=false`)
      this.socket = socket
      const timer = setTimeout(() => reject(new Error(`client ${this.index}: not subscribed within 30 s`)), 30_000)
      socket.addEventListener('message', async (event) => {
        const frame = JSON.parse(event.data)
        switch (frame.event) {
          case 'pusher:connection_established': {
            const socketId = JSON.parse(frame.data).socket_id
            try {
              for (const channel of channels) {
                const auth = await this.json('broadcasting-auth', 'POST', '/broadcasting/auth', { socket_id: socketId, channel_name: channel })
                socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel, ...auth } }))
              }
            } catch (error) {
              reject(error)
            }
            break
          }
          case 'pusher_internal:subscription_succeeded':
            pending.delete(frame.channel)
            if (pending.size === 0) {
              clearTimeout(timer)
              resolve()
            }
            break
          case 'pusher:ping':
            socket.send(JSON.stringify({ event: 'pusher:pong', data: {} }))
            break
          case 'pusher:error':
          case 'pusher:subscription_error':
            this.errors.push(`${frame.event}: ${typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)}`)
            break
          case 'message.created': {
            const at = now()
            const message = JSON.parse(frame.data)
            if (message.client_id) {
              if (this.received.has(message.client_id)) this.duplicates += 1
              else this.received.set(message.client_id, at)
            }
            break
          }
        }
      })
      socket.addEventListener('close', () => {
        if (!this.stopping) this.closed += 1
      })
      socket.addEventListener('error', () => reject(new Error(`client ${this.index}: WebSocket error`)))
    })
  }

  startHeartbeat() {
    const beat = () => this.json('heartbeat', 'POST', '/api/v1/presence/heartbeat', { active: true }).catch((error) => this.errors.push(String(error.message)))
    // Spread over the period, as tabs opened at different times would be.
    this.heartbeat = setTimeout(() => {
      beat()
      this.heartbeat = setInterval(beat, HEARTBEAT_MS)
    }, (this.index * HEARTBEAT_MS) / CLIENTS)
  }

  stop() {
    this.stopping = true
    clearTimeout(this.heartbeat)
    clearInterval(this.heartbeat)
    this.socket?.close()
  }
}

/** n tasks, at most `limit` at a time. */
async function pool(items, limit, task) {
  const results = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await task(items[index])
      }
    }),
  )
  return results
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const round = (v) => (v === null ? null : Math.round(v * 10) / 10)
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? null),
  }
}

async function main() {
  const startedAt = new Date().toISOString()
  const clients = Array.from({ length: CLIENTS }, (_, index) => new Client(index + 1))

  phase = 'sign-in'
  const t0 = now()
  await pool(clients, 10, (client) => client.signIn())
  const signInSeconds = (now() - t0) / 1000

  phase = 'channel'
  const owner = clients[0]
  const channel = await owner.json('api', 'POST', '/api/v1/channels', { name: `load-${Date.now().toString(36)}`, kind: 'public', topic: null })
  await pool(clients.slice(1), 10, (client) => client.json('api', 'POST', `/api/v1/channels/${channel.id}/join`))

  phase = 'subscribe'
  const t1 = now()
  const workspace = owner.me.workspace_id
  await pool(clients, 10, (client) => client.connect([`private-channel.${channel.id}`, `presence-workspace.${workspace}`]))
  const subscribeSeconds = (now() - t1) / 1000
  for (const client of clients) client.startHeartbeat()

  phase = 'send'
  const senders = clients.slice(0, SENDERS)
  const total = Math.round(RATE * SECONDS)
  const sent = new Map() // client_id -> {at, ok}
  const posts = []
  const t2 = now()
  const sendStartedEpoch = Date.now()
  for (let k = 0; k < total; k++) {
    const due = t2 + (k * 1000) / RATE
    const wait = due - now()
    if (wait > 0) await sleep(wait)
    const sender = senders[k % senders.length]
    const clientId = randomUUID()
    const entry = { at: now(), ok: false }
    sent.set(clientId, entry)
    posts.push(
      sender
        .json('post-message', 'POST', `/api/v1/channels/${channel.id}/messages`, { body: `load test message ${k + 1} of ${total}`, client_id: clientId, parent_id: null })
        .then(() => {
          entry.ok = true
        })
        .catch((error) => sender.errors.push(String(error.message))),
    )
  }
  await Promise.all(posts)
  const sendSeconds = (now() - t2) / 1000
  const sendEndedEpoch = Date.now()

  phase = 'drain'
  const okIds = [...sent].filter(([, entry]) => entry.ok).map(([id]) => id)
  const expected = okIds.length * clients.length
  const deliveredCount = () => clients.reduce((sum, client) => sum + okIds.filter((id) => client.received.has(id)).length, 0)
  const drainUntil = now() + DRAIN_SECONDS * 1000
  while (now() < drainUntil && deliveredCount() < expected) await sleep(250)

  for (const client of clients) client.stop()

  const latencies = []
  let delivered = 0
  let unexpected = 0
  for (const client of clients) {
    for (const [id, at] of client.received) {
      const entry = sent.get(id)
      if (entry === undefined || !entry.ok) {
        unexpected += 1
        continue
      }
      delivered += 1
      latencies.push(at - entry.at)
    }
  }
  const httpSummary = Object.fromEntries(Object.entries(http).map(([kind, entry]) => [kind, { count: entry.count, errors: entry.errors, latency_ms: stats(entry.latencies) }]))
  const httpCount = Object.values(http).reduce((sum, entry) => sum + entry.count, 0)
  const httpErrors = Object.values(http).reduce((sum, entry) => sum + entry.errors, 0)
  const errors = clients.flatMap((client) => client.errors.map((error) => `client ${client.index}: ${error}`))

  const result = {
    started_at: startedAt,
    config: { clients: CLIENTS, senders: SENDERS, rate_per_second: RATE, seconds: SECONDS, drain_seconds: DRAIN_SECONDS },
    phases: {
      sign_in_seconds: round1(signInSeconds),
      subscribe_seconds: round1(subscribeSeconds),
      send_seconds: round1(sendSeconds),
      // Wall-clock bounds of the send phase (epoch ms), to pick the matching docker stats samples.
      send_started_at: sendStartedEpoch,
      send_ended_at: sendEndedEpoch,
    },
    messages: { attempted: total, accepted: okIds.length, achieved_rate_per_second: round1(okIds.length / sendSeconds) },
    deliveries: {
      expected,
      delivered,
      lost: expected - delivered,
      duplicates: clients.reduce((sum, client) => sum + client.duplicates, 0),
      unexpected,
      latency_ms: stats(latencies),
    },
    http: { requests: httpCount, errors: httpErrors, error_rate: httpCount === 0 ? 0 : httpErrors / httpCount, by_kind: httpSummary },
    websocket: { closed_before_end: clients.reduce((sum, client) => sum + client.closed, 0) },
    errors: errors.slice(0, 20),
    error_count: errors.length,
  }
  writeFileSync(OUT, JSON.stringify(result, null, 2))
  const d = result.deliveries
  console.log(
    `load: ${CLIENTS} clients, ${okIds.length}/${total} messages at ${result.messages.achieved_rate_per_second}/s, ` +
      `${d.delivered}/${d.expected} deliveries (lost ${d.lost}, duplicates ${d.duplicates}), ` +
      `latency p50 ${d.latency_ms.p50} ms p95 ${d.latency_ms.p95} ms p99 ${d.latency_ms.p99} ms, ` +
      `HTTP errors ${httpErrors}/${httpCount}`,
  )
  const ok = d.lost === 0 && d.duplicates === 0 && httpErrors === 0 && errors.length === 0 && okIds.length === total && result.websocket.closed_before_end === 0
  process.exit(ok ? 0 : 1)
}

main().catch((error) => {
  // A request's error already starts with its phase ("[sign-in] POST ..."): not said twice.
  const message = error.message.startsWith('[') ? error.message : `[${phase}] ${error.message}`
  console.error(`load test failed: ${message}`)
  process.exit(1)
})
