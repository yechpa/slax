/**
 * The tasks of one of my lists, of my inbox (given to me, not filed yet), or the ones I gave
 * to others. Fetched on opening and again whenever `tasksVersion` changes (a live event, the
 * minute's poll, our own writes); a failed refetch keeps what is shown. Open tasks first, the
 * completed ones under a "Done (n)" section that folds.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { isApiError } from '../../api/client.ts'
import { api } from '../../api/endpoints.ts'
import type { Task } from '../../api/types.ts'
import { t } from '../../i18n/index.ts'
import { useLocale } from '../../i18n/useLocale.ts'
import type { TasksView } from '../../router.ts'
import { tasksVersion } from '../../store/tasks.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { NewTaskForm } from './NewTaskForm.tsx'
import { TaskRow } from './TaskRow.tsx'

export type OwnTasksView = Exclude<TasksView, { kind: 'user' }>

function fetchView(view: OwnTasksView, signal: AbortSignal): Promise<Task[]> {
  if (view.kind === 'inbox') return api.tasks.inbox(signal)
  if (view.kind === 'by-me') return api.tasks.byMe(signal)
  return api.tasks.listTasks(view.id, signal)
}

const EMPTY = { inbox: 'tasks.empty.inbox', 'by-me': 'tasks.empty.byMe', list: 'tasks.empty.list' } as const

/** Give it a `key` per view: another view starts afresh. */
export function TaskListView({ view }: { view: OwnTasksView }) {
  useLocale()
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [failure, setFailure] = useState<null | 'error' | 'not-found'>(null)
  const [attempt, setAttempt] = useState(0)
  const shown = useRef(false)
  const version = tasksVersion.value

  useEffect(() => {
    const controller = new AbortController()
    fetchView(view, controller.signal).then(
      (list) => {
        shown.current = true
        setTasks(list)
        setFailure(null)
      },
      (error: unknown) => {
        if (controller.signal.aborted || isApiError(error, 'aborted')) return
        if (isApiError(error, 'not_found')) {
          shown.current = false
          setTasks(null)
          setFailure('not-found')
        } else if (!shown.current) setFailure('error')
      },
    )
    return () => controller.abort()
    // `view` is fixed for this component's life (keyed by the page).
  }, [version, attempt])

  const change = (next: Task) => setTasks((list) => list && list.map((item) => (item.id === next.id ? next : item)))
  const remove = (id: number) => setTasks((list) => list && list.filter((item) => item.id !== id))
  const add = (created: Task) => {
    if (view.kind === 'list' && created.list_id === view.id) setTasks((list) => (list ? [...list, created] : list))
  }

  let content
  if (failure === 'not-found') content = <EmptyState>{t('tasks.notFound')}</EmptyState>
  else if (tasks === null && failure === 'error') {
    content = (
      <EmptyState>
        {t('tasks.loadError')}{' '}
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            setFailure(null)
            setAttempt((n) => n + 1)
          }}
        >
          {t('action.retry')}
        </Button>
      </EmptyState>
    )
  } else if (tasks === null) {
    content = (
      <p class="tasks__loading" role="status">
        {t('app.loading')}
      </p>
    )
  } else if (tasks.length === 0) content = <EmptyState>{t(EMPTY[view.kind])}</EmptyState>
  else {
    const open = tasks.filter((item) => !item.completed)
    const done = tasks.filter((item) => item.completed)
    const row = (item: Task) => <TaskRow key={item.id} task={item} onChange={change} onRemove={remove} />
    content = (
      <>
        <ul class="tasks__list tasks__open" aria-label={t('tasks.open')}>
          {open.map(row)}
        </ul>
        {done.length > 0 && (
          <details class="tasks__done">
            <summary class="tasks__done-title">{t('tasks.done', { count: done.length })}</summary>
            <ul class="tasks__list">{done.map(row)}</ul>
          </details>
        )}
      </>
    )
  }

  return (
    <div class="tasks" id="messages" tabIndex={-1}>
      {view.kind === 'list' && failure !== 'not-found' && <NewTaskForm listId={view.id} onCreated={add} />}
      {content}
    </div>
  )
}
