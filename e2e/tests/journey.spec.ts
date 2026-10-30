/**
 * The whole journey of one person, in each language and each theme: sign in through
 * "Google" (an unverified address first: refused, explained in the page's language), land
 * in #general and write there, join a channel and, there, reply in a thread, react, send a
 * file (and see a hostile one refused), open a conversation and see the other person's
 * presence, then switch theme and language. A second browser (another person) watches
 * what should be live.
 */
import { expect, test } from '@playwright/test'
import { api, closeAll, expectLook, isolated, newContext, openChannel, reload, send, signIn, signInThroughGoogle, ui, uniq, type Person } from '../support/app.ts'
import { LOCALES, THEMES, dirOf, plural, t, type Locale, type Theme } from '../support/i18n.ts'

/** What another language and theme look like, for the switchers at the end. */
const otherLocale: Record<Locale, Locale> = { en: 'he', he: 'fr', fr: 'en' }
const otherTheme: Record<Theme, Theme> = { console: 'listing', listing: 'console' }

/** Names in the page's own script: a Hebrew name in Hebrew, to exercise bidi along the way. */
const names: Record<Locale, string> = { en: 'Ada', he: 'נועה', fr: 'Aurélie' }

/** A Windows executable header in a file named .txt: the scanner must refuse it. */
const PE_HEADER = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(58), Buffer.from([0x40, 0, 0, 0]), Buffer.from('PE\0\0'), Buffer.alloc(200, 0x90)])

for (const locale of LOCALES) {
  for (const theme of THEMES) {
    test(`journey in ${locale}, ${theme} theme`, async ({ browser }) => {
      let me: Person | undefined
      let peer: Person | undefined
      try {
        // The second browser: someone already in #general.
        peer = await signIn(browser, `Peer ${uniq('p')}`)
        await openChannel(peer, '#general')

        // --- Sign in: an unverified Google address is refused, in this language.
        const context = await newContext(browser, { locale, theme })
        const page = await context.newPage()
        const email = `${uniq('journey')}@example.test`
        await signInThroughGoogle(page, { email, name: names[locale], locale, verified: false })
        await expect(page.getByRole('alert')).toHaveText(t(locale, 'auth.error.email_unverified'))
        await expect(page).toHaveURL('/')
        await expectLook(page, locale, theme)

        await signInThroughGoogle(page, { email, name: names[locale], locale })
        await expect(page.getByRole('navigation', { name: t(locale, 'nav.label') })).toBeVisible()
        const { id } = await api(page).get<{ id: number }>('/me')
        me = { context, page, id, name: names[locale], email, locale, theme }
        const view = ui(me)
        await expectLook(page, locale, theme)

        // --- #general: a new member is in it from the first sign-in, and lands there.
        await expect(view.header.locator('.channel-header__name')).toHaveText('#general')
        await expect(view.navItem('general')).toHaveAttribute('aria-current', 'page')
        await expect(view.composer).toBeVisible()

        // --- Write: sent, and live in the other browser.
        const hello = `hello from ${locale}/${theme} ${uniq('m')}`
        await send(me, hello)
        await expect(ui(peer).sent(hello)).toHaveCount(1)

        // --- Join a channel someone else created (browse, join), where the rest happens: a
        // quiet room, unlike #general where the parallel journeys keep posting.
        const room = uniq('room')
        await api(peer.page).createChannel(room, 'public', 'joined from the browse dialog')
        await page.getByRole('button', { name: t(locale, 'nav.browse') }).click()
        const browse = page.getByRole('dialog', { name: t(locale, 'channel.browse.title') })
        await browse.getByLabel(t(locale, 'channel.browse.filter')).fill(room)
        await browse.locator('.browse__item', { hasText: room }).getByRole('button', { name: t(locale, 'action.join') }).click()
        await expect(view.toasts).toContainText(t(locale, 'channel.joined', { channel: `#${room}` }))
        await expect(view.header.locator('.channel-header__name')).toHaveText(`#${room}`)
        await reload(peer)
        await openChannel(peer, room)
        const words = `first words in ${room}`
        await send(me, words)
        await expect(ui(peer).sent(words)).toHaveCount(1)

        // --- Reply in a thread.
        const parent = view.sent(words)
        await parent.hover()
        await parent.getByRole('button', { name: t(locale, 'action.reply'), exact: true }).click()
        await expect(page).toHaveURL(/\/c\/\d+\/t\/\d+$/)
        await expect(view.thread).toBeVisible()
        const answer = `thread reply ${uniq('r')}`
        await view.threadComposer.fill(answer)
        await view.threadComposer.press('Enter')
        await expect(view.reply(answer)).toHaveCount(1)
        await expect(parent.locator('.thread-link')).toContainText(plural(locale, 'message.replies', 1))
        await expect(ui(peer).sent(words).locator('.thread-link')).toContainText(plural('en', 'message.replies', 1))
        await page.keyboard.press('Escape')
        await expect(view.thread).toHaveCount(0)

        // --- React: my chip is pressed, the other browser sees the count.
        await parent.hover()
        await parent.getByRole('button', { name: t(locale, 'action.react'), exact: true }).click()
        const firstEmoji = page.locator('.popover--placed .emoji-picker .emoji-picker__item').first()
        const emoji = (await firstEmoji.textContent()) ?? ''
        await firstEmoji.click()
        await expect(parent.getByRole('button', { name: plural(locale, 'reaction.label', 1, { emoji }) })).toHaveAttribute('aria-pressed', 'true')
        await expect(ui(peer).sent(words).getByRole('button', { name: plural('en', 'reaction.label', 1, { emoji }) })).toHaveAttribute('aria-pressed', 'false')

        // --- Send a file: a small text file goes through the scanner and is posted.
        const fileName = `${uniq('notes')}.txt`
        await view.filePicker.setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from('Notes from the e2e journey.\n') })
        await expect(view.tray.locator('.file-chip--ready', { hasText: fileName })).toBeVisible()
        await view.composer.press('Enter')
        await expect(view.log.locator('.message__attachments .file-chip', { hasText: fileName })).toBeVisible()
        await expect(view.tray).toHaveCount(0)
        await expect(ui(peer).log.locator('.message__attachments .file-chip', { hasText: fileName })).toBeVisible()

        // ...and a hostile one (an executable passed off as text) is refused, said in this language.
        const hostile = `${uniq('invoice')}.txt`
        await view.filePicker.setInputFiles({ name: hostile, mimeType: 'text/plain', buffer: PE_HEADER })
        const refused = view.tray.locator('.file-chip--error', { hasText: hostile })
        await expect(refused).toContainText(t(locale, 'upload.error.type_not_allowed', { name: hostile }))
        await refused.getByRole('button', { name: t(locale, 'file.remove', { name: hostile }) }).click()
        await expect(view.tray).toHaveCount(0)

        // --- A conversation with the other person, whose presence shows.
        await page.getByRole('button', { name: t(locale, 'nav.newMessage') }).click()
        const dialog = page.getByRole('dialog', { name: t(locale, 'dm.title') })
        await dialog.getByRole('combobox').fill(peer.name)
        await dialog.getByRole('option', { name: peer.name }).click()
        await dialog.getByRole('button', { name: t(locale, 'dm.start') }).click()
        await expect(view.header.locator('.channel-header__name')).toHaveText(isolated(peer.name))
        await expect(view.navItem(peer.name).getByRole('img', { name: t(locale, 'presence.online') })).toBeVisible()
        await send(me, `a word in private ${uniq('dm')}`)

        // --- Theme and language: applied at once, kept after a reload, saved to the account.
        const nextTheme = otherTheme[theme]
        const nextLocale = otherLocale[locale]
        await view.userMenu.click()
        await page.getByRole('radio', { name: t(locale, `theme.${nextTheme}`) }).check()
        await expectLook(page, locale, nextTheme)
        await page.getByRole('radio', { name: t(nextLocale, `locale.${nextLocale}`) }).check()
        await expectLook(page, nextLocale, nextTheme)
        await expect(page.locator('.shell__footer .composer__hint')).toHaveText(t(nextLocale, 'composer.hint'))
        await expect(page.getByRole('navigation', { name: t(nextLocale, 'nav.label') })).toBeVisible()
        await expect.poll(async () => api(page).get<{ locale: string; theme: string }>('/me')).toMatchObject({ locale: nextLocale, theme: nextTheme })
        await page.reload()
        await expectLook(page, nextLocale, nextTheme)
        await expect(page.locator('html')).toHaveAttribute('dir', dirOf(nextLocale))
        await expect(page.locator('.shell__footer .composer__hint')).toHaveText(t(nextLocale, 'composer.hint'))
      } finally {
        await closeAll(me, peer)
      }
    })
  }
}
