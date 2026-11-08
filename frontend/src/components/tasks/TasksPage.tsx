/**
 * The tasks area (/tasks/…): the same header as a channel (the drawer's toggle on small
 * screens, the title the main region is named by), then the view the route asks for: my
 * inbox, what I gave to others, or one of my lists. A colleague's page (`user`) is Task 12's
 * ColleagueTasks; until then it shows the header only.
 */
import type { Ref } from 'preact'
import { useEffect } from 'preact/hooks'
import { t } from '../../i18n/index.ts'
import { useLocale } from '../../i18n/useLocale.ts'
import type { TasksView } from '../../router.ts'
import { taskLists } from '../../store/tasks.ts'
import { NavToggle } from '../NavToggle.tsx'
import { TaskListView } from './TaskListView.tsx'

type Props = {
  view: TasksView
  navOpen: boolean
  onToggleNav: () => void
  toggleRef: Ref<HTMLButtonElement>
}

export function TasksPage({ view, navOpen, onToggleNav, toggleRef }: Props) {
  useLocale()
  let title = t('tasks.title')
  let own = false
  if (view.kind === 'inbox') title = t('tasks.inbox')
  else if (view.kind === 'by-me') title = t('tasks.byMe')
  else if (view.kind === 'list') {
    const list = taskLists.value.find((item) => item.id === view.id)
    if (list) {
      title = list.name
      own = true
    }
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
            {/* A list's name is the user's text: its own direction. */}
            {own ? <bdi>{title}</bdi> : title}
          </h2>
        </div>
      </header>
      {view.kind === 'user' ? (
        <div class="tasks" id="messages" tabIndex={-1} />
      ) : (
        <TaskListView key={view.kind === 'list' ? `list-${view.id}` : view.kind} view={view} />
      )}
      <div />
    </>
  )
}
