/**
 * The sidebar's tasks section: what was given to me and is not filed yet (badge: the ones
 * still to do), what I gave to others, my lists (with their open tasks as a hint), and two
 * actions opening the task dialogs through `taskDialog`: a new list, someone else's tasks.
 */
import type { ComponentChildren } from 'preact'
import { plural, t } from '../../i18n/index.ts'
import { useLocale } from '../../i18n/useLocale.ts'
import { route, tasksPath, type TasksView } from '../../router.ts'
import { inboxToFile, taskDialog, taskLists, type TaskDialog } from '../../store/tasks.ts'
import { badgeText } from '../ui/NavItem.tsx'

type Props = {
  /** A link was followed or a dialog opened (closes the drawer on small screens). */
  onNavigate?: () => void
}

const same = (a: TasksView, b: TasksView) => a.kind === b.kind && ('id' in a ? 'id' in b && a.id === b.id : true)

export function TasksSidebar({ onNavigate }: Props) {
  useLocale()
  const current = route.value
  const shown = current.name === 'tasks' ? current.view : null
  const toFile = inboxToFile.value
  const link = (view: TasksView, sigil: string, label: string, extra?: ComponentChildren, unread = false) => (
    <a
      class={unread ? 'nav-item nav-item--unread' : 'nav-item'}
      href={tasksPath(view)}
      aria-current={shown && same(shown, view) ? 'page' : undefined}
      onClick={onNavigate}
    >
      <span class="nav-item__sigil" aria-hidden="true">
        {sigil}
      </span>
      <bdi class="nav-item__label">{label}</bdi>
      {extra}
    </a>
  )
  const open = (dialog: TaskDialog) => () => {
    onNavigate?.()
    taskDialog.value = dialog
  }

  return (
    <>
      <h2 class="sidebar__heading">
        <span class="sidebar__heading-label">{t('nav.tasks')}</span>
      </h2>
      <ul class="sidebar__list">
        <li>
          {link(
            { kind: 'inbox' },
            '@',
            t('tasks.inbox'),
            toFile > 0 && (
              <span class="nav-item__badge" role="img" aria-label={plural('tasks.toFile', toFile)}>
                {/* LTR-isolated: "99+" would print "+99" in a right-to-left line. */}
                <bdi dir="ltr" aria-hidden="true">
                  {badgeText(toFile)}
                </bdi>
              </span>
            ),
            toFile > 0,
          )}
        </li>
        <li>{link({ kind: 'by-me' }, '>', t('tasks.byMe'))}</li>
        {taskLists.value.map((list) => (
          <li key={list.id}>
            {link(
              { kind: 'list', id: list.id },
              '-',
              list.name,
              list.open_count > 0 && (
                <span class="nav-item__tag" role="img" aria-label={plural('tasks.openCount', list.open_count)}>
                  <bdi dir="ltr" aria-hidden="true">
                    {badgeText(list.open_count)}
                  </bdi>
                </span>
              ),
            )}
          </li>
        ))}
        <li>
          <Action sigil="+" label={t('tasks.newList')} onClick={open({ kind: 'new-list' })} />
        </li>
        <li>
          <Action sigil=">" label={t('tasks.people')} onClick={open({ kind: 'people' })} />
        </li>
      </ul>
    </>
  )
}

/** A row opening a dialog, like the sidebar's "New channel". */
function Action({ sigil, label, onClick }: { sigil: string; label: string; onClick: () => void }) {
  return (
    <button type="button" class="nav-item nav-item--action" aria-haspopup="dialog" onClick={onClick}>
      <span class="nav-item__sigil" aria-hidden="true">
        {sigil}
      </span>
      <span class="nav-item__label">{label}</span>
    </button>
  )
}
