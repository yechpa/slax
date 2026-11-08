/**
 * What can be done to a task, as a menu on its row: rename, change its visibility, assign it
 * to someone, delete it (its author); move it between lists (the person holding it); give it
 * back to its author (the person holding it, when someone else wrote it). Each item shows only
 * when the viewer may do it (spec §6, mirrored here); the server still decides. "Assign to…"
 * and "Move to…" open their dialogs through `taskDialog` (Workspace renders them).
 */
import { useRef, useState } from 'preact/hooks'
import { isApiError } from '../../api/client.ts'
import type { Task } from '../../api/types.ts'
import { t } from '../../i18n/index.ts'
import { taskDialog } from '../../store/tasks.ts'
import { Menu } from '../MessageActions.tsx'
import { Popover } from '../ui/Popover.tsx'

/** What `meId` may do to `task` (the server's rules, for showing only what will be accepted). */
export function taskRights(task: Task, meId: number | null) {
  const author = meId !== null && task.creator.id === meId
  const holder = meId !== null && task.assignee.id === meId
  return { edit: author, tick: author || holder, move: holder, giveBack: holder && !author }
}

/** The server's refusals by rule, each with its own sentence (`tasks.error.<code>`). */
const REFUSALS = new Set(['task_list_limit', 'task_limit', 'inbox_full', 'invalid_assignee', 'invalid_list', 'validation'])

/** A failed task call, said in the reader's language; `fallback` is the key for anything else. */
export function taskErrorText(error: unknown, fallback: string): string {
  if (isApiError(error) && REFUSALS.has(error.code)) return t(`tasks.error.${error.code}`)
  if (isApiError(error, 'not_found')) return t('tasks.error.gone')
  return t(fallback)
}

type Props = {
  task: Task
  meId: number | null
  onRename: () => void
  onToggleVisibility: () => void
  onReturn: () => void
  onDelete: () => void
}

export function TaskMenu({ task, meId, onRename, onToggleVisibility, onReturn, onDelete }: Props) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const rights = taskRights(task, meId)

  const items: { label: string; run: () => void; danger?: boolean }[] = []
  if (rights.edit) {
    items.push({ label: t('tasks.rename'), run: onRename })
    items.push({ label: t(task.visibility === 'private' ? 'tasks.makePublic' : 'tasks.makePrivate'), run: onToggleVisibility })
    items.push({ label: t('tasks.assign'), run: () => (taskDialog.value = { kind: 'assign', task }) })
  }
  if (rights.move) items.push({ label: t('tasks.move'), run: () => (taskDialog.value = { kind: 'move', task }) })
  if (rights.giveBack) items.push({ label: t('tasks.return', { name: task.creator.name }), run: onReturn })
  if (rights.edit) items.push({ label: t('action.delete'), run: onDelete, danger: true })
  if (items.length === 0) return null

  return (
    <>
      <button
        ref={button}
        type="button"
        class="task-row__more"
        aria-label={t('tasks.actions', { title: task.title })}
        title={t('tasks.actions', { title: task.title })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        ···
      </button>
      {open && (
        <Popover
          anchor={button}
          onClose={(restoreFocus) => {
            setOpen(false)
            if (restoreFocus) button.current?.focus()
          }}
        >
          <Menu
            items={items}
            onDone={(item) => {
              setOpen(false)
              item.run()
            }}
            onTab={() => setOpen(false)}
          />
        </Popover>
      )}
    </>
  )
}
