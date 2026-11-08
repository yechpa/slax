/**
 * "Assign to…": one person, from the directory (it never returns a banned account). The task
 * goes to their "Assigned to me" and leaves my lists. Only its author gets here (TaskMenu);
 * the server decides (a full inbox, an account that cannot receive tasks) and is answered in words.
 */
import { useRef, useState } from 'preact/hooks'
import { api } from '../../api/endpoints.ts'
import type { Task, UserSummary } from '../../api/types.ts'
import { t } from '../../i18n/index.ts'
import { useLocale } from '../../i18n/useLocale.ts'
import { refreshTasks } from '../../store/tasks.ts'
import { showToast } from '../../store/ui.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { PeoplePicker } from '../PeoplePicker.tsx'
import { tasksPane } from './pane.ts'
import { taskErrorText } from './TaskMenu.tsx'

export function AssignDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  useLocale()
  const [person, setPerson] = useState<UserSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const assigned = useRef(false)

  const assign = async () => {
    if (!person || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.tasks.update(task.id, { assignee_id: person.id })
      assigned.current = true
      showToast({ tone: 'success', text: t('tasks.sent', { name: person.name }) })
      void refreshTasks()
      onClose()
    } catch (failure) {
      setBusy(false)
      setError(taskErrorText(failure, 'tasks.error.update'))
    }
  }

  return (
    <Dialog
      title={t('tasks.assign.title', { title: task.title })}
      onClose={onClose}
      onSubmit={() => void assign()}
      class="dialog--people"
      returnFocus={() => (assigned.current ? tasksPane() : document.querySelector<HTMLElement>(`[data-task-id="${task.id}"] .task-row__more`))}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={person === null || busy}>
            {t('tasks.assign.submit')}
          </Button>
        </>
      }
    >
      <PeoplePicker
        label={t('tasks.assignTo')}
        placeholder={t('people.placeholder')}
        hint={t('tasks.assign.hint')}
        selected={person ? [person] : []}
        exclude={[task.assignee.id]}
        full={person !== null}
        fullText={t('tasks.oneAssignee')}
        disabled={busy}
        onSelect={(chosen) => {
          setError(null)
          setPerson(chosen)
        }}
        onRemove={() => setPerson(null)}
      />
      {error && (
        <p class="field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
