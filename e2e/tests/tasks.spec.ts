/**
 * Task lists, through the app's own screens, in each theme: lists made with the "New list"
 * dialog and tasks with the form at the top of a list (private to begin with), what a colleague
 * may see of them on their page (People's tasks), a task assigned from its menu that arrives
 * live in the colleague's "Assigned to me", is filed by them into one of their lists and stays
 * in its author's "Assigned by me", a task given back to its author, and the tasks area in
 * Hebrew (right to left, a Hebrew title drawn in its own direction).
 */
import { expect, test, type Locator } from '@playwright/test'
import { api, closeAll, expectLook, signIn, ui, uniq, type Person } from '../support/app.ts'
import { THEMES, plural, t, type Locale, type Theme } from '../support/i18n.ts'

const people: Person[] = []
test.afterEach(async () => {
  await closeAll(...people.splice(0))
})

async function person(browser: Parameters<typeof signIn>[0], name: string, locale: Locale, theme: Theme): Promise<Person> {
  const signedIn = await signIn(browser, name, { locale, theme })
  people.push(signedIn)
  return signedIn
}

/** The tasks area as this person sees it, in their language. */
function tasks(who: Person) {
  const { page, locale } = who
  const main = page.locator('.shell__main')
  return {
    main,
    title: main.locator('.channel-header__name'),
    form: main.getByRole('form', { name: t(locale, 'tasks.new') }),
    /** A task's row on the page shown, by its title. */
    row: (title: string) => main.locator('.task-row', { has: page.locator('.task-row__title', { hasText: title }) }),
    empty: main.locator('.empty p'),
  }
}

/** Opens a view of the sidebar's tasks section (an in-app navigation) and waits for its title. */
async function openTasks(who: Person, label: string, title = label): Promise<void> {
  await ui(who).navItem(label).click()
  await expect(tasks(who).title).toHaveText(title)
  await expect(tasks(who).main.locator('.tasks__loading')).toHaveCount(0)
}

/** "New list" in the sidebar: the dialog, a name, and the new list opens. */
async function newList(who: Person, name: string): Promise<void> {
  const { page, locale } = who
  await page.getByRole('button', { name: t(locale, 'tasks.newList'), exact: true }).click()
  const dialog = page.getByRole('dialog', { name: t(locale, 'tasks.newList') })
  await dialog.getByLabel(t(locale, 'tasks.list.name'), { exact: true }).fill(name)
  await dialog.getByRole('button', { name: t(locale, 'tasks.list.create'), exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(tasks(who).title).toHaveText(name)
  await expect(ui(who).navItem(name)).toHaveAttribute('aria-current', 'page')
  await expect(tasks(who).empty).toHaveText(t(locale, 'tasks.empty.list'))
}

/** Picks someone in a people picker (a combobox searching the directory). */
async function pick(scope: Locator, name: string): Promise<void> {
  await scope.locator('.people-picker').getByRole('combobox').fill(name)
  await scope.getByRole('option', { name }).click()
}

/** The create form at the top of the list shown: a title, the visibility (private unless asked), whom it is for. */
async function addTask(who: Person, title: string, { visibility = 'private', list, assignee }: { visibility?: 'private' | 'public'; list?: string; assignee?: string } = {}) {
  const { locale } = who
  const form = tasks(who).form
  // Private is the starting value, shown.
  await expect(form.getByRole('radio', { name: t(locale, 'tasks.visibility.private'), exact: true })).toBeChecked()
  await form.getByLabel(t(locale, 'tasks.titleLabel'), { exact: true }).fill(title)
  if (visibility === 'public') await form.getByRole('radio', { name: t(locale, 'tasks.visibility.public'), exact: true }).check()
  if (list) await form.getByLabel(t(locale, 'tasks.list'), { exact: true }).selectOption({ label: list })
  if (assignee) {
    await pick(form, assignee)
    await expect(form).toContainText(t(locale, 'tasks.goesToInbox', { name: assignee }))
  }
  await form.getByRole('button', { name: t(locale, 'tasks.add'), exact: true }).click()
  // Sent: the form is empty again, back to private.
  await expect(form.getByLabel(t(locale, 'tasks.titleLabel'), { exact: true })).toHaveValue('')
  await expect(form.getByRole('radio', { name: t(locale, 'tasks.visibility.private'), exact: true })).toBeChecked()
}

/** A task's menu ("···" on its row), then one of its items. */
async function taskMenu(who: Person, title: string, item: string): Promise<void> {
  const { page, locale } = who
  await tasks(who).row(title).getByRole('button', { name: t(locale, 'tasks.actions', { title }), exact: true }).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

/** The badge on "Assigned to me": how many tasks given to me are still to file. */
const inboxBadge = (who: Person) => ui(who).navItem(t(who.locale, 'tasks.inbox')).locator('.nav-item__badge')

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test('create lists, a public and a private task; the colleague sees only the public one', async ({ browser }) => {
      const author = await person(browser, `Ada ${uniq('a')}`, 'en', theme)
      const colleague = await person(browser, `Bo ${uniq('b')}`, 'en', theme)
      await expectLook(author.page, 'en', theme)
      const shared = uniq('errands')
      const secret = uniq('surprise')
      const visible = `buy stamps ${uniq('t')}`
      const hidden = `book the venue ${uniq('t')}`
      const alsoHidden = `wrap the present ${uniq('t')}`

      // --- Two lists, from the sidebar's "New list".
      await newList(author, shared)
      await newList(author, secret)
      await expect(ui(author).navItem(shared)).toBeVisible()

      // --- In the first list a public task and a private one; in the second, a private one only.
      await openTasks(author, shared)
      await addTask(author, visible, { visibility: 'public' })
      await addTask(author, hidden)
      await addTask(author, alsoHidden, { list: secret })
      const view = tasks(author)
      await expect(view.row(visible).locator('.task-row__visibility')).toHaveText(t('en', 'tasks.public'))
      await expect(view.row(hidden).locator('.task-row__visibility')).toHaveText(t('en', 'tasks.private'))
      await expect(view.row(alsoHidden)).toHaveCount(0)
      await openTasks(author, secret)
      await expect(view.row(alsoHidden)).toHaveCount(1)
      // The open count of each list, in the sidebar.
      await expect(ui(author).navItem(shared).getByRole('img', { name: plural('en', 'tasks.openCount', 2) })).toBeVisible()

      // --- The colleague opens the author's page from "People's tasks": the public task, under its list.
      const { page } = colleague
      await page.getByRole('button', { name: t('en', 'tasks.people'), exact: true }).click()
      const dialog = page.getByRole('dialog', { name: t('en', 'tasks.people') })
      await pick(dialog, author.name)
      await expect(dialog).toHaveCount(0)
      await expect(page).toHaveURL(`/tasks/u/${author.id}`)
      const theirs = tasks(colleague)
      await expect(theirs.title).toHaveText(t('en', 'tasks.ofUser', { name: author.name }))
      await expect(theirs.row(visible)).toHaveCount(1)
      await expect(theirs.main.locator('.tasks__group-title')).toHaveText([shared])
      // ...nothing of the private ones, not even the name of the list holding only a private task.
      await expect(theirs.row(hidden)).toHaveCount(0)
      await expect(theirs.row(alsoHidden)).toHaveCount(0)
      await expect(theirs.main).not.toContainText(secret)
      // Read-only for them: no tick, no menu on a task they neither wrote nor hold.
      await expect(theirs.row(visible).getByRole('checkbox', { name: visible })).toBeDisabled()
      await expect(theirs.row(visible).locator('.task-row__more')).toHaveCount(0)

      // The API behind the page says no more than the page.
      const answer = JSON.stringify(await api(page).get(`/users/${author.id}/tasks`))
      expect(answer).toContain(visible)
      for (const text of [hidden, alsoHidden, secret]) expect(answer).not.toContain(text)
    })

    test('assign a task to the colleague, they get it in "Assignées à moi", file it into a list, and the author sees it under "Assignées par moi"', async ({
      browser,
    }) => {
      const author = await person(browser, `Ada ${uniq('a')}`, 'en', theme)
      // The colleague reads French: "Assignées à moi", "Assignées par moi".
      const colleague = await person(browser, `Chloé ${uniq('c')}`, 'fr', theme)
      const title = `send the invoices ${uniq('t')}`
      const mine = uniq('work')
      const theirList = uniq('bureau')

      await newList(author, mine)
      await addTask(author, title)
      await expect(tasks(author).row(title)).toHaveCount(1)

      // The colleague waits on their (empty) "Assignées à moi".
      await openTasks(colleague, t('fr', 'tasks.inbox'))
      await expect(tasks(colleague).empty).toHaveText(t('fr', 'tasks.empty.inbox'))
      await expect(inboxBadge(colleague)).toHaveCount(0)

      // --- The author assigns it from the task's menu: it leaves their list.
      await taskMenu(author, title, t('en', 'tasks.assign'))
      const assign = author.page.getByRole('dialog', { name: t('en', 'tasks.assign.title', { title }) })
      await pick(assign, colleague.name)
      await assign.getByRole('button', { name: t('en', 'tasks.assign.submit'), exact: true }).click()
      await expect(assign).toHaveCount(0)
      await expect(ui(author).toasts).toContainText(t('en', 'tasks.sent', { name: colleague.name }))
      await expect(tasks(author).row(title)).toHaveCount(0)

      // --- It arrives live in the colleague's "Assignées à moi", from the author, counted to file.
      const inbox = tasks(colleague)
      await expect(inbox.row(title)).toHaveCount(1)
      await expect(inbox.row(title).locator('.task-row__person')).toHaveText(t('fr', 'tasks.from', { name: author.name }))
      await expect(inboxBadge(colleague)).toHaveAttribute('aria-label', plural('fr', 'tasks.toFile', 1))

      // --- They make a list of their own and file the task into it ("Déplacer vers…").
      await newList(colleague, theirList)
      await openTasks(colleague, t('fr', 'tasks.inbox'))
      await taskMenu(colleague, title, t('fr', 'tasks.move'))
      const move = colleague.page.getByRole('dialog', { name: t('fr', 'tasks.move.title', { title }) })
      await expect(move.getByRole('radio', { name: t('fr', 'tasks.move.inbox') })).toBeChecked()
      await move.getByRole('radio', { name: theirList }).check()
      await move.getByRole('button', { name: t('fr', 'tasks.move.submit'), exact: true }).click()
      await expect(move).toHaveCount(0)
      await expect(inbox.row(title)).toHaveCount(0)
      await expect(inbox.empty).toHaveText(t('fr', 'tasks.empty.inbox'))
      await expect(inboxBadge(colleague)).toHaveCount(0)
      await openTasks(colleague, theirList)
      await expect(inbox.row(title)).toHaveCount(1)
      // They hold it: they may tick it.
      await expect(inbox.row(title).getByRole('checkbox', { name: title })).toBeEnabled()

      // --- The author still sees it, under "Assignées par moi", for the colleague.
      await openTasks(author, t('en', 'tasks.byMe'))
      const byMe = tasks(author)
      await expect(byMe.row(title)).toHaveCount(1)
      await expect(byMe.row(title).locator('.task-row__person')).toHaveText(t('en', 'tasks.for', { name: colleague.name }))
      // Filed in the colleague's list, not in any of the author's.
      await openTasks(author, mine)
      await expect(tasks(author).row(title)).toHaveCount(0)
    })

    test('the colleague returns a task to its author', async ({ browser }) => {
      // The author reads French this time.
      const author = await person(browser, `Aurélie ${uniq('a')}`, 'fr', theme)
      const colleague = await person(browser, `Bo ${uniq('b')}`, 'en', theme)
      const title = `call the plumber ${uniq('t')}`

      // --- Created straight for the colleague, from the form ("Assign to").
      await newList(author, uniq('maison'))
      await addTask(author, title, { visibility: 'public', assignee: colleague.name })
      await expect(ui(author).toasts).toContainText(t('fr', 'tasks.sent', { name: colleague.name }))
      await expect(tasks(author).row(title)).toHaveCount(0)

      await openTasks(colleague, t('en', 'tasks.inbox'))
      const inbox = tasks(colleague)
      await expect(inbox.row(title)).toHaveCount(1)
      await expect(inboxBadge(colleague)).toHaveAttribute('aria-label', plural('en', 'tasks.toFile', 1))

      // --- "Return to …" from its menu: gone from their inbox.
      await taskMenu(colleague, title, t('en', 'tasks.return', { name: author.name }))
      await expect(ui(colleague).toasts).toContainText(t('en', 'tasks.returned', { name: author.name }))
      await expect(inbox.row(title)).toHaveCount(0)
      await expect(inbox.empty).toHaveText(t('en', 'tasks.empty.inbox'))
      await expect(inboxBadge(colleague)).toHaveCount(0)

      // --- Back with its author, in their own "Assignées à moi"; nothing left under "Assignées par moi".
      await openTasks(author, t('fr', 'tasks.inbox'))
      const back = tasks(author)
      await expect(back.row(title)).toHaveCount(1)
      await expect(back.row(title).locator('.task-row__person')).toHaveCount(0)
      await expect(inboxBadge(author)).toHaveAttribute('aria-label', plural('fr', 'tasks.toFile', 1))
      await openTasks(author, t('fr', 'tasks.byMe'))
      await expect(back.empty).toHaveText(t('fr', 'tasks.empty.byMe'))
    })

    test('Hebrew: the tasks area is right to left and a Hebrew title displays correctly', async ({ browser }) => {
      const reader = await person(browser, 'נועה', 'he', theme)
      await expectLook(reader.page, 'he', theme)
      const { page } = reader
      const listName = 'קניות'
      const title = 'לקנות חלב ולחם לשבת'

      await newList(reader, listName)
      await addTask(reader, title, { visibility: 'public' })
      const view = tasks(reader)
      const row = view.row(title)
      await expect(row).toHaveCount(1)
      await expect(row.locator('.task-row__title')).toHaveText(title)
      await expect(row.locator('.task-row__visibility')).toHaveText(t('he', 'tasks.public'))
      await expect(row.getByRole('checkbox', { name: title })).toBeEnabled()

      const width = page.viewportSize()?.width ?? 0
      const rect = (locator: Locator) => locator.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect)

      // --- The sidebar (with the list's name) is on the right; the tasks pane on its left.
      const nav = await rect(ui(reader).nav)
      expect(nav.right).toBeGreaterThanOrEqual(width - 1)
      expect((await rect(view.main)).right).toBeLessThanOrEqual(nav.left + 1)
      await expect(ui(reader).navItem(listName)).toHaveAttribute('aria-current', 'page')

      // --- A row reads from the right: the checkbox first, then the title, the menu last (on the left).
      const tick = await rect(row.locator('.task-row__check'))
      const text = await rect(row.locator('.task-row__title'))
      const more = await rect(row.locator('.task-row__more'))
      expect(tick.left, 'the checkbox at the inline start (right)').toBeGreaterThanOrEqual(text.right - 1)
      expect(more.right, 'the menu at the inline end (left)').toBeLessThanOrEqual(text.left + 1)
      // The form's button sits at the inline end too.
      const form = await rect(view.form)
      const add = await rect(view.form.getByRole('button', { name: t('he', 'tasks.add'), exact: true }))
      expect(add.left - form.left).toBeLessThan(form.right - add.right)

      // --- The Hebrew title is drawn right to left: its first letter rightmost, its last leftmost.
      const titleEl = row.locator('.task-row__title')
      await expect(titleEl).toHaveCSS('direction', 'rtl')
      const boxes = await titleEl.evaluate((element) => {
        const out: { ch: string; left: number; right: number }[] = []
        const node = element.firstChild
        const content = node?.textContent ?? ''
        for (let i = 0; i < content.length; i += 1) {
          const range = document.createRange()
          range.setStart(node as Node, i)
          range.setEnd(node as Node, i + 1)
          const box = range.getBoundingClientRect()
          if (box.width > 0) out.push({ ch: content[i] ?? '', left: box.left, right: box.right })
        }
        return out
      })
      expect(boxes.map((box) => box.ch).join('')).toBe(title)
      const first = boxes[0]
      const last = boxes[boxes.length - 1]
      expect(first && last, 'the title is drawn').toBeTruthy()
      for (const box of boxes) {
        expect(box.right).toBeLessThanOrEqual((first?.right ?? 0) + 0.5)
        expect(box.left).toBeGreaterThanOrEqual((last?.left ?? 0) - 0.5)
      }
      // Every letter inside the row's title cell, nothing clipped off the left.
      expect(last?.left ?? 0).toBeGreaterThanOrEqual(text.left - 0.5)

      // --- The menu in Hebrew, then nothing scrolls sideways.
      await row.getByRole('button', { name: t('he', 'tasks.actions', { title }), exact: true }).click()
      await expect(page.getByRole('menuitem', { name: t('he', 'tasks.makePrivate'), exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      const overflow = await page.evaluate(() =>
        [document.documentElement, ...document.querySelectorAll<HTMLElement>('.tasks, .sidebar__scroll')]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.className || element.tagName),
      )
      expect(overflow, 'nothing scrolls sideways (in RTL it would hang off the unreachable left)').toEqual([])
    })
  })
}
