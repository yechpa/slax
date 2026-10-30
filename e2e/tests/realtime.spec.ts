/**
 * What has to happen live between two browsers (two people, two contexts, two sockets):
 * messages without a reload, a network cut survived without losing or doubling anything,
 * a removed member who stops receiving, typing, and presence.
 */
import { expect, test } from '@playwright/test'
import {
  api,
  closeAll,
  countLoads,
  openChannel,
  realtimeSwitch,
  recordFrames,
  reload,
  roomWith,
  send,
  signIn,
  ui,
  uniq,
  type Person,
} from '../support/app.ts'
import { t } from '../support/i18n.ts'

const people: Person[] = []
test.afterEach(async () => {
  await closeAll(...people.splice(0))
})

async function person(browser: Parameters<typeof signIn>[0], name: string): Promise<Person> {
  const signedIn = await signIn(browser, `${name} ${uniq('n')}`)
  people.push(signedIn)
  return signedIn
}

test('two browsers see each other’s messages and reactions without reloading', async ({ browser }) => {
  const a = await person(browser, 'Ari')
  const b = await person(browser, 'Bea')
  await roomWith(a, [b])
  const loadsA = countLoads(a.page)
  const loadsB = countLoads(b.page)

  const first = `from Ari ${uniq('m')}`
  await send(a, first)
  await expect(ui(b).sent(first)).toHaveCount(1)

  const second = `from Bea ${uniq('m')}`
  await send(b, second)
  await expect(ui(a).sent(second)).toHaveCount(1)

  // A reaction and a reply count arrive live as well.
  const message = ui(b).sent(first)
  await message.hover()
  await message.getByRole('button', { name: t('en', 'action.react'), exact: true }).click()
  await b.page.locator('.popover--placed .emoji-picker__item').first().click()
  await expect(ui(a).sent(first).locator('.reaction:not(.reaction--add)')).toHaveAttribute('aria-pressed', 'false')
  await expect(ui(b).sent(first).locator('.reaction:not(.reaction--add)')).toHaveAttribute('aria-pressed', 'true')

  expect(loadsA()).toBe(0)
  expect(loadsB()).toBe(0)
})

test('a network cut, then back: nothing lost, nothing doubled (client_id)', async ({ browser }) => {
  const a = await person(browser, 'Cyd')
  const b = await person(browser, 'Dov')
  const realtime = await realtimeSwitch(b.page)
  const room = await roomWith(a, [b])
  const loadsB = countLoads(b.page)
  const before = `before the cut ${uniq('m')}`
  await send(a, before)
  await expect(ui(b).sent(before)).toHaveCount(1)

  // B loses the network: no HTTP, no socket.
  await b.context.setOffline(true)
  await realtime.cut()

  // B writes meanwhile: it cannot go, and says so.
  const fromB = `written offline ${uniq('m')}`
  await ui(b).composer.fill(fromB)
  await ui(b).composer.press('Enter')
  await expect(ui(b).message(fromB).getByRole('alert')).toHaveText(t('en', 'error.sendFailed'))

  // A keeps talking.
  const missed = [`while away 1 ${uniq('m')}`, `while away 2 ${uniq('m')}`]
  for (const text of missed) await send(a, text)

  // Back online: the missed messages come in, B's message goes out on retry, each exactly once.
  realtime.resume()
  await b.context.setOffline(false)
  for (const text of missed) await expect(ui(b).sent(text)).toHaveCount(1)
  await ui(b).message(fromB).getByRole('button', { name: t('en', 'action.retry') }).click()
  await expect(ui(b).sent(fromB)).toHaveCount(1)
  await expect(ui(a).sent(fromB)).toHaveCount(1)
  for (const text of [before, ...missed]) await expect(ui(b).message(text)).toHaveCount(1)
  expect(loadsB()).toBe(0)

  // And the server holds each once.
  const messages = await api(a.page).messages(room.id)
  for (const text of [before, fromB, ...missed]) expect(messages.filter((m) => m.body === text)).toHaveLength(1)
  await reload(b)
  await openChannel(b, room.name)
  for (const text of [before, fromB, ...missed]) await expect(ui(b).sent(text)).toHaveCount(1)
})

test('a message whose answer was lost is retried under the same client_id and stored once', async ({ browser }) => {
  const a = await person(browser, 'Eli')
  const b = await person(browser, 'Fay')
  const realtime = await realtimeSwitch(a.page)
  const room = await roomWith(a, [b])

  // The server stores the message, but its answer never reaches A (and A's socket is down,
  // so no realtime copy confirms it either): A can only retry.
  await realtime.cut()
  const text = `answer lost ${uniq('m')}`
  let stored = 0
  await a.page.route(`**/api/v1/channels/${room.id}/messages`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const response = await route.fetch()
    stored = response.status()
    await route.abort('connectionreset')
  })
  await ui(a).composer.fill(text)
  await ui(a).composer.press('Enter')
  await expect(ui(a).message(text).getByRole('alert')).toHaveText(t('en', 'error.sendFailed'))
  expect(stored).toBe(201)
  await expect(ui(b).sent(text)).toHaveCount(1)

  await a.page.unroute(`**/api/v1/channels/${room.id}/messages`)
  realtime.resume()
  const retried = a.page.waitForResponse((response) => response.url().endsWith(`/channels/${room.id}/messages`) && response.request().method() === 'POST')
  await ui(a).message(text).getByRole('button', { name: t('en', 'action.retry') }).click()
  // 200, not 201: the server recognised the client_id and returned the message it already had.
  expect((await retried).status()).toBe(200)
  await expect(ui(a).sent(text)).toHaveCount(1)
  await expect(ui(b).message(text)).toHaveCount(1)
  const messages = await api(b.page).messages(room.id)
  expect(messages.filter((m) => m.body === text)).toHaveLength(1)
})

test('a member removed from a private channel receives nothing from it any more', async ({ browser }) => {
  const owner = await person(browser, 'Gil')
  const removed = await person(browser, 'Hen')
  const frames = recordFrames(removed.page)
  const secret = await roomWith(owner, [removed], 'private')
  // Somewhere both stay members: what arrives there proves the socket still works.
  const shared = await api(owner.page).createChannel(uniq('shared'))
  await api(removed.page).join(shared.id)

  const hello = `before removal ${uniq('m')}`
  await send(owner, hello)
  await expect(ui(removed).sent(hello)).toHaveCount(1)

  // The owner removes Hen from the channel details.
  await ui(owner).header.locator('.channel-header__details').click()
  const details = owner.page.getByRole('dialog')
  await details.getByRole('button', { name: t('en', 'details.remove', { name: removed.name }) }).click()
  await expect(details.getByRole('button', { name: t('en', 'details.remove', { name: removed.name }) })).toHaveCount(0)
  await details.getByRole('button', { name: t('en', 'action.close') }).first().click()

  // Hen's socket is closed, the channel's authorization refused on reconnection, and the
  // open channel says it is gone (the supported behaviour; see docs/known-limitations.md).
  await expect(ui(removed).nav.locator('a.nav-item', { hasText: secret.name })).toHaveCount(0)
  await expect(removed.page.locator('.shell__main')).toContainText(t('en', 'error.notFound'))

  // Then: a secret in the private channel, and a sentinel in the shared one. Broadcasts go
  // through one queue worker in order, so once the sentinel has arrived, the secret would have.
  const words = `after removal ${uniq('secret')}`
  await api(owner.page).postMessage(secret.id, words)
  const sentinel = `sentinel ${uniq('s')}`
  await api(owner.page).postMessage(shared.id, sentinel)
  await expect.poll(() => frames.some((frame) => frame.includes(sentinel)), { timeout: 15_000 }).toBe(true)
  expect(frames.filter((frame) => frame.includes(words))).toEqual([])

  // Nor over REST, nor after a reload.
  await reload(removed)
  await expect(ui(removed).nav.locator('a.nav-item', { hasText: secret.name })).toHaveCount(0)
  await removed.page.goto(`/c/${secret.id}`)
  await expect(removed.page.locator('.shell__main')).toContainText(t('en', 'error.notFound'))
  await expect(removed.page.getByText(words)).toHaveCount(0)
})

test('typing shows in the other browser, by name, and stops when the message is sent', async ({ browser }) => {
  const a = await person(browser, 'Ira')
  const b = await person(browser, 'Jo')
  await roomWith(a, [b])
  const text = `typed slowly ${uniq('m')}`

  await ui(a).composer.pressSequentially('typing…')
  await expect(ui(b).typing).toHaveText(t('en', 'typing.one', { name: a.name }))
  // Never to myself.
  await expect(ui(a).typing).toHaveText('')

  await ui(a).composer.fill(text)
  await ui(a).composer.press('Enter')
  await expect(ui(b).sent(text)).toHaveCount(1)
  await expect(ui(b).typing).toHaveText('')

  // In a thread, it shows in the thread, not under the channel.
  const parent = ui(b).sent(text)
  await parent.hover()
  await parent.getByRole('button', { name: t('en', 'action.reply'), exact: true }).click()
  await ui(a).sent(text).hover()
  await ui(a).sent(text).getByRole('button', { name: t('en', 'action.reply'), exact: true }).click()
  await ui(a).threadComposer.pressSequentially('in the thread')
  await expect(b.page.locator('.thread .typing')).toHaveText(t('en', 'typing.one', { name: a.name }))
  await expect(ui(b).typing).toHaveText('')
})

test('presence: online in the other browser, offline once it closes, and it stays offline', async ({ browser }) => {
  const a = await person(browser, 'Kim')
  const b = await person(browser, 'Lev')
  await a.page.clock.install()
  await api(a.page).openConversation([b.id])
  await reload(a)
  await reload(b)
  const dot = ui(a).navItem(b.name).locator('.presence')

  await expect(dot).toHaveAttribute('aria-label', t('en', 'presence.online'))

  // B idles: after five minutes without a key or a click, its heartbeats say so (its own
  // view shows "away"; others see it at their next poll once the server's own five-minute
  // window has passed, which is not waited for here).
  await b.page.clock.install()
  await reload(b)
  await send(b, `still here ${uniq('m')}`)
  const idle = b.page.waitForRequest((request) => request.url().endsWith('/presence/heartbeat') && request.postDataJSON()?.active === false)
  await b.page.clock.fastForward('05:30')
  await idle
  await expect(ui(b).log.locator('article.message .presence').last()).toHaveClass(/presence--away/)

  // B closes the app: offline at once (the presence channel says it left)...
  await b.context.close()
  people.splice(people.indexOf(b), 1)
  await expect(dot).toHaveAttribute('aria-label', t('en', 'presence.offline'))

  // ...and still offline after A's next poll, although the server keeps B's last heartbeat
  // for up to a minute.
  const polled = a.page.waitForResponse((response) => response.url().includes('/api/v1/presence?'))
  await a.page.clock.fastForward('00:31')
  await polled
  await expect(dot).toHaveAttribute('aria-label', t('en', 'presence.offline'))
})
