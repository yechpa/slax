/**
 * A colleague's page (/tasks/u/:id): what they hold that I may see, one group per list, the
 * tasks in no list under "No list". Read-only but for what my rights on each task allow
 * (TaskRow/TaskMenu: the ones I wrote for them I may tick, rename, reassign, delete). Fetched
 * on opening and again whenever `tasksVersion` changes; a failed refetch keeps what is shown.
 * A banned or unknown account answers 404: "not available".
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { isApiError } from '../../api/client.ts'
import { api } from '../../api/endpoints.ts'
import type { ColleagueTasks as Page, Task, UserSummary } from '../../api/types.ts'
import { t } from '../../i18n/index.ts'
import { useLocale } from '../../i18n/useLocale.ts'
import { tasksVersion } from '../../store/tasks.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { TaskRow } from './TaskRow.tsx'

type Props = {
  userId: number
  /** Who the page is about once known (null: not available), for the page's title. */
  onUser: (user: UserSummary | null) => void
}

/** Give it a `key` per person: another person starts afresh. */
export function ColleagueTasks({ userId, onUser }: Props) {
  useLocale()
  const [page, setPage] = useState<Page | null>(null)
  const [failure, setFailure] = useState<null | 'error' | 'not-found'>(null)
  const [attempt, setAttempt] = useState(0)
  const shown = useRef(false)
  const announce = useRef(onUser)
  announce.current = onUser
  const version = tasksVersion.value

  useEffect(() => {
    const controller = new AbortController()
    api.tasks.ofUser(userId, controller.signal).then(
      (answer) => {
        shown.current = true
        setPage(answer)
        setFailure(null)
        announce.current(answer.user)
      },
      (error: unknown) => {
        if (controller.signal.aborted || isApiError(error, 'aborted')) return
        if (isApiError(error, 'not_found')) {
          shown.current = false
          setPage(null)
          setFailure('not-found')
          announce.current(null)
        } else if (!shown.current) setFailure('error')
      },
    )
    return () => controller.abort()
  }, [userId, version, attempt])

  const edit = (change: (tasks: Task[]) => Task[]) =>
    setPage((current) => current && { ...current, lists: current.lists.map((list) => ({ ...list, tasks: change(list.tasks) })), unfiled: change(current.unfiled) })
  const change = (next: Task) => edit((tasks) => tasks.map((item) => (item.id === next.id ? next : item)))
  const remove = (id: number) => edit((tasks) => tasks.filter((item) => item.id !== id))

  let content
  if (failure === 'not-found') content = <EmptyState>{t('tasks.user.notFound')}</EmptyState>
  else if (page === null && failure === 'error') {
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
  } else if (page === null) {
    content = (
      <p class="tasks__loading" role="status">
        {t('app.loading')}
      </p>
    )
  } else {
    const groups = [
      ...page.lists.map((list) => ({ key: `l${list.id}`, name: list.name, own: true, tasks: list.tasks })),
      { key: 'none', name: t('tasks.noList'), own: false, tasks: page.unfiled },
    ].filter((group) => group.tasks.length > 0)
    content =
      groups.length === 0 ? (
        <EmptyState>{t('tasks.empty.user', { name: page.user.name })}</EmptyState>
      ) : (
        groups.map((group) => (
          <section class="tasks__group" key={group.key}>
            <h3 class="tasks__group-title" id={`tasks-group-${group.key}`}>
              {/* A list's name is the colleague's text: its own direction. */}
              {group.own ? <bdi>{group.name}</bdi> : group.name}
            </h3>
            <ul class="tasks__list" aria-labelledby={`tasks-group-${group.key}`}>
              {group.tasks.map((item) => (
                <TaskRow key={item.id} task={item} onChange={change} onRemove={remove} />
              ))}
            </ul>
          </section>
        ))
      )
  }

  return (
    <div class="tasks" id="messages" tabIndex={-1}>
      {content}
    </div>
  )
}
