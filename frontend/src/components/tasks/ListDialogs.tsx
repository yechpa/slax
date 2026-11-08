/**
 * The dialogs on lists: a new one (opened once created), a new name, and the confirmation of
 * a deletion, which says what happens to the tasks inside (spec §6: the ones the owner wrote
 * go, the ones others gave return to their inbox). Each is rendered by `TaskDialogs`; `onClose`
 * clears `taskDialog`. One request at a time; a refusal is said in the reader's language.
 */
import { useRef, useState } from 'preact/hooks'
import { isApiError } from '../../api/client.ts'
import { api } from '../../api/endpoints.ts'
import type { TaskList } from '../../api/types.ts'
import { t } from '../../i18n/index.ts'
import { useLocale } from '../../i18n/useLocale.ts'
import { navigate, route, tasksPath } from '../../router.ts'
import { refreshTasks } from '../../store/tasks.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { TextField } from '../ui/TextField.tsx'
import { tasksPane } from './pane.ts'
import { taskErrorText } from './TaskMenu.tsx'

export const LIST_NAME_MAX = 60

type Props = { onClose: () => void }

/** A failed list call, said in the reader's language. */
function listErrorText(error: unknown, fallback: string): string {
  if (isApiError(error, 'validation')) return t('tasks.error.listName')
  if (isApiError(error, 'not_found')) return t('tasks.error.invalid_list')
  return taskErrorText(error, fallback)
}

/** A name to type and a button: the body of both the new-list and the rename dialog. */
function NameDialog({ title, initial, submitLabel, save, onClose }: Props & { title: string; initial: string; submitLabel: string; save: (name: string) => Promise<void> }) {
  useLocale()
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  const submit = async () => {
    if (busy) return
    const text = name.trim()
    if (text === '' || [...text].length > LIST_NAME_MAX) {
      setError(t('tasks.error.listName'))
      field.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await save(text)
      onClose()
    } catch (failure) {
      setBusy(false)
      setError(listErrorText(failure, 'tasks.error.list'))
    }
  }

  return (
    <Dialog
      title={title}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <TextField
        ref={field}
        label={t('tasks.list.name')}
        error={error ?? undefined}
        value={name}
        maxLength={LIST_NAME_MAX}
        autocomplete="off"
        dir="auto"
        onInput={(event) => {
          setName(event.currentTarget.value)
          setError(null)
        }}
      />
    </Dialog>
  )
}

/** Creates a list, then opens it. */
export function NewListDialog({ onClose }: Props) {
  useLocale()
  return (
    <NameDialog
      title={t('tasks.newList')}
      initial=""
      submitLabel={t('tasks.list.create')}
      onClose={onClose}
      save={async (name) => {
        const list = await api.tasks.createList(name)
        void refreshTasks()
        navigate(tasksPath({ kind: 'list', id: list.id }))
      }}
    />
  )
}

export function RenameListDialog({ list, onClose }: Props & { list: TaskList }) {
  useLocale()
  return (
    <NameDialog
      title={t('tasks.list.rename')}
      initial={list.name}
      submitLabel={t('action.save')}
      onClose={onClose}
      save={async (name) => {
        if (name === list.name) return
        await api.tasks.renameList(list.id, name)
        void refreshTasks()
      }}
    />
  )
}

/** Asks first: what goes with the list is not undone. Deleting the list on screen opens the inbox. */
export function DeleteListDialog({ list, onClose }: Props & { list: TaskList }) {
  useLocale()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const gone = useRef(false)

  const remove = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.tasks.deleteList(list.id)
      gone.current = true
      void refreshTasks()
      const current = route.peek()
      if (current.name === 'tasks' && current.view.kind === 'list' && current.view.id === list.id) navigate(tasksPath({ kind: 'inbox' }))
      onClose()
    } catch (failure) {
      setBusy(false)
      setError(listErrorText(failure, 'tasks.error.listDelete'))
    }
  }

  return (
    <Dialog
      title={t('tasks.list.delete')}
      role="alertdialog"
      onClose={onClose}
      onSubmit={() => void remove()}
      // The list (and the button that opened this) is gone: the page itself.
      returnFocus={() => (gone.current ? tasksPane() : undefined)}
      description={
        <>
          <p>{t('tasks.list.deleteWritten', { name: list.name })}</p>
          <p>{t('tasks.list.deleteReceived')}</p>
        </>
      }
      footer={
        <>
          <Button variant="quiet" data-autofocus onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="danger" type="submit" disabled={busy}>
            {t('tasks.list.delete')}
          </Button>
        </>
      }
    >
      {error && (
        <p class="field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
