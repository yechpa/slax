/**
 * "Assign to…": one person, from the directory (it never returns a banned account). The task
 * goes to their "Assigned to me" and leaves my lists. "Also assign to…" (`also`): several people,
 * each gets their own copy and the task stays where it is. Only its author gets here (TaskMenu);
 * the server decides (a full inbox, an account that cannot receive tasks) and is answered in words.
 */
import { useRef, useState } from 'preact/hooks'
import { api } from '../../api/endpoints.ts'
import type { Task, UserSummary } from '../../api/types.ts'
import { t } from '../../i18n/index.ts'
import { useLocale } from '../../i18n/useLocale.ts'
import { MAX_ASSIGNEES, refreshTasks } from '../../store/tasks.ts'
import { showToast } from '../../store/ui.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { PeoplePicker } from '../PeoplePicker.tsx'
import { tasksPane } from './pane.ts'
import { taskErrorText } from './TaskMenu.tsx'

export function AssignDialog({ task, also = false, onClose }: { task: Task; also?: boolean; onClose: () => void }) {
  useLocale()
  const [people, setPeople] = useState<UserSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const assigned = useRef(false)
  const limit = also ? MAX_ASSIGNEES : 1

  const assign = async () => {
    if (people.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      if (also) {
        const copies = await api.tasks.assign(
          task.id,
          people.map((p) => p.id),
        )
        const names = people.filter((p) => copies.some((c) => c.assignee.id === p.id)).map((p) => p.name)
        showToast(names.length > 0 ? { tone: 'success', text: t('tasks.sent', { name: names.join(', ') }) } : { tone: 'info', text: t('tasks.assignAlso.none') })
      } else {
        await api.tasks.update(task.id, { assignee_id: people[0].id })
        showToast({ tone: 'success', text: t('tasks.sent', { name: people[0].name }) })
      }
      assigned.current = true
      void refreshTasks()
      onClose()
    } catch (failure) {
      setBusy(false)
      setError(taskErrorText(failure, 'tasks.error.update'))
    }
  }

  return (
    <Dialog
      title={t(also ? 'tasks.assignAlso.title' : 'tasks.assign.title', { title: task.title })}
      onClose={onClose}
      onSubmit={() => void assign()}
      class="dialog--people"
      returnFocus={() => (assigned.current && !also ? tasksPane() : document.querySelector<HTMLElement>(`[data-task-id="${task.id}"] .task-row__more`))}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={people.length === 0 || busy}>
            {t('tasks.assign.submit')}
          </Button>
        </>
      }
    >
      <PeoplePicker
        label={t('tasks.assignTo')}
        placeholder={t('people.placeholder')}
        hint={t(also ? 'tasks.assignAlso.hint' : 'tasks.assign.hint')}
        selected={people}
        exclude={[task.assignee.id]}
        full={people.length >= limit}
        fullText={also ? t('tasks.manyAssignees', { count: MAX_ASSIGNEES }) : t('tasks.oneAssignee')}
        disabled={busy}
        onSelect={(chosen) => {
          setError(null)
          setPeople([...people, chosen])
        }}
        onRemove={(removed) => setPeople(people.filter((p) => p.id !== removed.id))}
      />
      {error && (
        <p class="field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
