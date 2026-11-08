/**
 * The tasks area (/tasks/…): the same header as a channel (the drawer's toggle on small
 * screens, the title the main region is named by), then the view the route asks for: my
 * inbox, what I gave to others, one of my lists (with its rename and delete actions in the
 * header), or a colleague's page (`user`).
 */
import type { Ref } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { TaskList, UserSummary } from '../../api/types.ts'
import { t } from '../../i18n/index.ts'
import { useLocale } from '../../i18n/useLocale.ts'
import type { TasksView } from '../../router.ts'
import { taskDialog, taskLists } from '../../store/tasks.ts'
import { NavToggle } from '../NavToggle.tsx'
import { Button } from '../ui/Button.tsx'
import { ColleagueTasks } from './ColleagueTasks.tsx'
import { TaskListView } from './TaskListView.tsx'

type Props = {
  view: TasksView
  navOpen: boolean
  onToggleNav: () => void
  toggleRef: Ref<HTMLButtonElement>
}

export function TasksPage({ view, navOpen, onToggleNav, toggleRef }: Props) {
  useLocale()
  // Who a colleague's page is about, once it has loaded (the title names them).
  const [colleague, setColleague] = useState<UserSummary | null>(null)
  let title = t('tasks.title')
  let own = false
  let list: TaskList | undefined
  if (view.kind === 'inbox') title = t('tasks.inbox')
  else if (view.kind === 'by-me') title = t('tasks.byMe')
  else if (view.kind === 'list') {
    list = taskLists.value.find((item) => item.id === view.id)
    if (list) {
      title = list.name
      own = true
    }
  } else if (colleague && colleague.id === view.id) {
    title = t('tasks.ofUser', { name: colleague.name })
    own = true
  }

  useEffect(() => {
    document.title = `${title} · slax`
  }, [title])

  return (
    <>
      <header class="channel-header">
        <NavToggle open={navOpen} onToggle={onToggleNav} buttonRef={toggleRef} />
        <div class="channel-header__title">
          <h2 class="channel-header__name" id="channel-title">
            {/* A list's or a person's name is the user's text: its own direction. */}
            {own ? <bdi>{title}</bdi> : title}
          </h2>
        </div>
        {list && (
          <div class="tasks-header__actions">
            <Button
              variant="quiet"
              size="sm"
              aria-haspopup="dialog"
              title={t('tasks.list.rename')}
              onClick={() => list && (taskDialog.value = { kind: 'rename-list', list })}
            >
              {t('tasks.rename')}
            </Button>
            <Button
              variant="quiet"
              size="sm"
              aria-haspopup="dialog"
              title={t('tasks.list.delete')}
              onClick={() => list && (taskDialog.value = { kind: 'delete-list', list })}
            >
              {t('action.delete')}
            </Button>
          </div>
        )}
      </header>
      {view.kind === 'user' ? (
        <ColleagueTasks key={view.id} userId={view.id} onUser={setColleague} />
      ) : (
        <TaskListView key={view.kind === 'list' ? `list-${view.id}` : view.kind} view={view} />
      )}
      <div />
    </>
  )
}
