/**
 * A new task, at the top of one of my lists: its title, whether it is public or private
 * (private to begin with: the safer choice after a careless click), and who it is for (me
 * by default, then into the chosen list; someone else, then into their "Assigned to me", and
 * the list choice goes). A refusal by the server is said in the reader's language and the
 * typed title stays.
 */
import { useId, useState } from 'preact/hooks'
import { api } from '../../api/endpoints.ts'
import type { Task, TaskVisibility, UserSummary } from '../../api/types.ts'
import { t } from '../../i18n/index.ts'
import { me } from '../../store/session.ts'
import { refreshTasks, taskLists } from '../../store/tasks.ts'
import { showToast } from '../../store/ui.ts'
import { Button } from '../ui/Button.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { TextField } from '../ui/TextField.tsx'
import { PeoplePicker } from '../PeoplePicker.tsx'
import { taskErrorText } from './TaskMenu.tsx'

type Props = {
  /** The list on screen: where my own new task goes unless I pick another. */
  listId: number
  onCreated: (task: Task) => void
}

const TITLE_MAX = 200

export function NewTaskForm({ listId, onCreated }: Props) {
  const [title, setTitle] = useState('')
  const [visibility, setVisibility] = useState<TaskVisibility>('private')
  const [assignee, setAssignee] = useState<UserSummary | null>(null)
  const [list, setList] = useState(listId)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const listField = useId()
  const lists = taskLists.value
  const meId = me.value?.id

  const submit = async (event: Event) => {
    event.preventDefault()
    const text = title.trim()
    if (text === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const created = await api.tasks.create(assignee ? { title: text, visibility, assignee_id: assignee.id } : { title: text, visibility, list_id: list })
      setTitle('')
      setVisibility('private')
      setAssignee(null)
      onCreated(created)
      if (assignee) showToast({ tone: 'success', text: t('tasks.sent', { name: assignee.name }) })
      void refreshTasks()
    } catch (failure) {
      setError(taskErrorText(failure, 'tasks.error.create'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form class="new-task" aria-label={t('tasks.new')} onSubmit={submit}>
      <TextField
        class="new-task__title"
        label={t('tasks.titleLabel')}
        placeholder={t('tasks.titlePlaceholder')}
        dir="auto"
        autocomplete="off"
        maxLength={TITLE_MAX}
        value={title}
        onInput={(event) => setTitle(event.currentTarget.value)}
      />
      <Segmented
        legend={t('tasks.visibility')}
        value={visibility}
        options={[
          { value: 'private', label: t('tasks.visibility.private'), title: t('tasks.privateHint') },
          { value: 'public', label: t('tasks.visibility.public'), title: t('tasks.publicHint') },
        ]}
        onChange={setVisibility}
      />
      <div class="new-task__who">
        <PeoplePicker
          label={t('tasks.assignTo')}
          placeholder={t('tasks.assignPlaceholder')}
          hint={assignee ? undefined : t('tasks.assignHint')}
          selected={assignee ? [assignee] : []}
          onSelect={setAssignee}
          onRemove={() => setAssignee(null)}
          exclude={meId === undefined ? [] : [meId]}
          full={assignee !== null}
          fullText={t('tasks.oneAssignee')}
        />
      </div>
      {assignee ? (
        <p class="new-task__inbox">{t('tasks.goesToInbox', { name: assignee.name })}</p>
      ) : (
        lists.length > 0 && (
          <div class="field new-task__list">
            <label class="field__label" for={listField}>
              {t('tasks.list')}
            </label>
            <select id={listField} class="input" value={String(list)} onChange={(event) => setList(Number(event.currentTarget.value))}>
              {lists.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
        )
      )}
      {error && (
        <p class="new-task__error" role="alert">
          {error}
        </p>
      )}
      <Button class="new-task__submit" type="submit" variant="primary" disabled={busy}>
        {t('tasks.add')}
      </Button>
    </form>
  )
}
