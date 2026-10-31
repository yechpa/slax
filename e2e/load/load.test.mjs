/**
 * load.mjs's own failure messages, against a local server that misbehaves (node --test; run
 * by make e2e before the load smoke). No stack needed.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const script = join(import.meta.dirname, 'load.mjs')

/** Runs load.mjs (one client) against `handler`; resolves to its exit code and stderr. */
async function runAgainst(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [script], {
        env: {
          ...process.env,
          LOAD_BASE_URL: `http://127.0.0.1:${port}`,
          LOAD_CLIENTS: '1',
          LOAD_SENDERS: '1',
          LOAD_RATE: '0.5',
          LOAD_SECONDS: '1',
          LOAD_OUT: join(tmpdir(), `load-test-${process.pid}.json`),
          LOAD_REQUEST_TIMEOUT_MS: '500',
        },
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('close', (code) => resolve({ code, stderr }))
    })
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

test('a body that never ends is a timeout named once with its phase and request', async () => {
  const { code, stderr } = await runAgainst((request, response) => {
    if (request.url === '/sanctum/csrf-cookie') return response.writeHead(204).end()
    // Headers at once, then half a body, then nothing.
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.write('{"redirect_url":')
  })
  assert.equal(code, 1)
  assert.equal(stderr, 'load test failed: [sign-in] POST /api/v1/auth/google/start: no answer within 0.5 s\n')
})

test('a request that gets no answer at all says the same, once', async () => {
  const { code, stderr } = await runAgainst((request, response) => {
    if (request.url === '/sanctum/csrf-cookie') return response.writeHead(204).end()
  })
  assert.equal(code, 1)
  assert.equal(stderr, 'load test failed: [sign-in] POST /api/v1/auth/google/start: no answer within 0.5 s\n')
})

test('an error of its own (not a request) is given its phase', async () => {
  const { code, stderr } = await runAgainst((request, response) => {
    if (request.url === '/sanctum/csrf-cookie') return response.writeHead(204).end()
    if (request.url.startsWith('/api/v1/auth/google/start')) {
      return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ redirect_url: '/auth/e2e/google?state=s&nonce=n' }))
    }
    if (request.url.startsWith('/auth/e2e/google/approve')) return response.writeHead(302, { Location: '/auth/google/callback?code=c&state=s' }).end()
    return response.writeHead(302, { Location: '/?auth_error=banned' }).end()
  })
  assert.equal(code, 1)
  assert.equal(stderr, 'load test failed: [sign-in] sign-in refused: /?auth_error=banned\n')
})
