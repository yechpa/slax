/**
 * One task: a checkbox (named by the title) that ticks it at once and puts it back if the
 * server refuses, the title in its own direction, whether it is public or private, who gave
 * it to me or whom I gave it to, and its menu. Renaming happens in the row (Enter saves,
 * Escape gives up); deleting asks first, in the row too.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { api } from '../../api/endpoints.ts'
import type { Task } from '../../api/types.ts'
import { t } from '../../i18n/index.ts'
import { me } from '../../store/session.ts'
import { refreshTasks } from '../../store/tasks.ts'
import { showToast } from '../../store/ui.ts'
import { Button } from '../ui/Button.tsx'
import { TaskMenu, taskErrorText, taskRights } from './TaskMenu.tsx'

type Props = {
  task: Task
  /** The task as it should now be shown (an optimistic tick, its rollback, the server's answer). */
  onChange: (task: Task) => void
  /** It leaves this view (deleted, given back). */
  onRemove: (id: number) => void
  /** About to be ticked or unticked (its row moves to the other section): where focus goes next. */
  onTick?: (id: number) => void
}

const TITLE_MAX = 200

export function TaskRow({ task, onChange, onRemove, onTick }: Props) {
  const meId = me.value?.id ?? null
  const rights = taskRights(task, meId)
  const [mode, setMode] = useState<'view' | 'rename' | 'confirm'>('view')

  const failed = (error: unknown) => showToast({ tone: 'error', text: taskErrorText(error, 'tasks.error.update'), key: `task-${task.id}` })

  const tick = async (completed: boolean) => {
    const before = task
    onTick?.(task.id)
    onChange({ ...task, completed, completed_at: completed ? new Date().toISOString() : null })
    try {
      onChange(await api.tasks.setCompleted(task.id, completed))
      void refreshTasks()
    } catch (error) {
      onChange(before)
      failed(error)
    }
  }

  const update = async (changes: { title?: string; visibility?: Task['visibility'] }) => {
    try {
      onChange(await api.tasks.update(task.id, changes))
    } catch (error) {
      failed(error)
    }
  }

  const giveBack = async () => {
    try {
      await api.tasks.returnToAuthor(task.id)
      onRemove(task.id)
      showToast({ tone: 'success', text: t('tasks.returned', { name: task.creator.name }) })
      void refreshTasks()
    } catch (error) {
      failed(error)
    }
  }

  const remove = async () => {
    setMode('view')
    try {
      await api.tasks.remove(task.id)
      onRemove(task.id)
      void refreshTasks()
    } catch (error) {
      failed(error)
    }
  }

  // The other person, when there is one: who gave it to me, or whom I gave it to.
  let person: string | null = null
  if (task.creator.id !== meId) person = t('tasks.from', { name: task.creator.name })
  else if (task.assignee.id !== meId) person = t('tasks.for', { name: task.assignee.name })

  return (
    <li class={task.completed ? 'task-row task-row--done' : 'task-row'} data-task-id={task.id}>
      <label class="task-row__tick">
        <input
          type="checkbox"
          class="task-row__check"
          aria-label={task.title}
          checked={task.completed}
          disabled={!rights.tick}
          onChange={(event) => void tick(event.currentTarget.checked)}
        />
      </label>
      {mode === 'rename' ? (
        <RenameField
          title={task.title}
          onDone={(title) => {
            setMode('view')
            if (title !== null && title !== task.title) void update({ title })
          }}
        />
      ) : (
        <span class="task-row__title" dir="auto">
          {task.title}
        </span>
      )}
      <span class="task-row__meta">
        <span
          class={task.visibility === 'public' ? 'task-row__visibility task-row__visibility--public' : 'task-row__visibility'}
          title={t(task.visibility === 'public' ? 'tasks.publicHint' : 'tasks.privateHint')}
        >
          {t(task.visibility === 'public' ? 'tasks.public' : 'tasks.private')}
        </span>
        {person && <span class="task-row__person">{person}</span>}
      </span>
      <span class="task-row__actions">
        <TaskMenu
          task={task}
          meId={meId}
          onRename={() => setMode('rename')}
          onToggleVisibility={() => void update({ visibility: task.visibility === 'private' ? 'public' : 'private' })}
          onReturn={() => void giveBack()}
          onDelete={() => setMode('confirm')}
        />
      </span>
      {mode === 'confirm' && <ConfirmDelete onConfirm={() => void remove()} onCancel={() => setMode('view')} />}
    </li>
  )
}

/** The title being edited; `onDone(null)` when given up (Escape, or nothing left but spaces). */
function RenameField({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(title)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])
  return (
    <form
      class="task-row__edit"
      onSubmit={(event) => {
        event.preventDefault()
        onDone(value.trim() || null)
      }}
    >
      <input
        ref={field}
        class="input"
        type="text"
        dir="auto"
        aria-label={t('tasks.renameLabel')}
        maxLength={TITLE_MAX}
        value={value}
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          onDone(null)
        }}
      />
      <Button type="submit" variant="quiet" size="sm">
        {t('action.save')}
      </Button>
    </form>
  )
}

function ConfirmDelete({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus(), [])
  return (
    <div class="task-row__confirm" role="group" aria-label={t('tasks.deleteConfirm')}>
      <span>{t('tasks.deleteConfirm')}</span>
      <Button variant="danger" size="sm" onClick={onConfirm}>
        {t('action.delete')}
      </Button>
      <Button ref={cancel} variant="quiet" size="sm" onClick={onCancel}>
        {t('action.cancel')}
      </Button>
    </div>
  )
}
