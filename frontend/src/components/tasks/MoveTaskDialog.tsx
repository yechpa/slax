/**
 * "Move to…": one of my lists, or back to "Assigned to me" (no list). Only the person holding
 * the task gets here (TaskMenu), and the server decides: a full list or a vanished one is
 * refused in words and the dialog stays. Once moved, the task has left the page it was
 * shown on: focus goes to the page.
 */
import { useId, useRef, useState } from 'preact/hooks'
import { api } from '../../api/endpoints.ts'
import type { Task } from '../../api/types.ts'
import { t } from '../../i18n/index.ts'
import { useLocale } from '../../i18n/useLocale.ts'
import { refreshTasks, taskLists } from '../../store/tasks.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { tasksPane } from './pane.ts'
import { taskErrorText } from './TaskMenu.tsx'

export function MoveTaskDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  useLocale()
  const [target, setTarget] = useState<number | null>(task.list_id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const moved = useRef(false)
  const group = useId()
  const options: { id: number | null; label: string }[] = [{ id: null, label: t('tasks.move.inbox') }, ...taskLists.value.map((list) => ({ id: list.id, label: list.name }))]

  const move = async () => {
    if (busy || target === task.list_id) return
    setBusy(true)
    setError(null)
    try {
      await api.tasks.move(task.id, target)
      moved.current = true
      void refreshTasks()
      onClose()
    } catch (failure) {
      setBusy(false)
      setError(taskErrorText(failure, 'tasks.error.update'))
    }
  }

  return (
    <Dialog
      title={t('tasks.move.title', { title: task.title })}
      onClose={onClose}
      onSubmit={() => void move()}
      returnFocus={() => (moved.current ? tasksPane() : document.querySelector<HTMLElement>(`[data-task-id="${task.id}"] .task-row__more`))}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={busy || target === task.list_id}>
            {t('tasks.move.submit')}
          </Button>
        </>
      }
    >
      <fieldset class="choice-list">
        <legend class="field__label">{t('tasks.move.legend')}</legend>
        {options.map((option) => (
          <label class="choice-list__option" key={option.id ?? 'inbox'}>
            <input type="radio" class="choice-list__input" name={group} checked={option.id === target} disabled={busy} onChange={() => setTarget(option.id)} />
            <bdi>{option.label}</bdi>
          </label>
        ))}
      </fieldset>
      {error && (
        <p class="field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
