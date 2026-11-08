/**
 * A new task, at the top of one of my lists: its title, whether it is public or private
 * (private to begin with: the safer choice after a careless click), and who it is for (me
 * by default, then into the chosen list; one or several colleagues, each getting their own copy
 * in their "Assigned to me", and "keep it for me too" adds my copy, in the chosen list). A refusal by the server is said in the reader's language and the
 * typed title stays.
 */
import { useId, useState } from 'preact/hooks'
import { api } from '../../api/endpoints.ts'
import type { Task, TaskVisibility, UserSummary } from '../../api/types.ts'
import { t } from '../../i18n/index.ts'
import { me } from '../../store/session.ts'
import { MAX_ASSIGNEES, refreshTasks, taskLists } from '../../store/tasks.ts'
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
  const [assignees, setAssignees] = useState<UserSummary[]>([])
  const [keepMine, setKeepMine] = useState(false)
  const [list, setList] = useState(listId)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const listField = useId()
  const lists = taskLists.value
  const meId = me.value?.id
  const keepId = useId()
  // My own copy goes into a list: the list choice stays when I have none, or keep one.
  const mine = assignees.length === 0 || (keepMine && meId !== undefined)
  // The server counts me among the people: keeping mine leaves room for one colleague less.
  const limit = MAX_ASSIGNEES - (keepMine ? 1 : 0)

  const submit = async (event: Event) => {
    event.preventDefault()
    const text = title.trim()
    if (text === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const others = assignees.map((p) => p.id)
      let body: Parameters<typeof api.tasks.create>[0]
      if (assignees.length === 0) body = { title: text, visibility, list_id: list }
      else if (!mine) body = others.length === 1 ? { title: text, visibility, assignee_id: others[0] } : { title: text, visibility, assignee_ids: others }
      else body = { title: text, visibility, list_id: list, assignee_ids: [meId!, ...others] }
      const created = await api.tasks.create(body)
      const sentTo = assignees.map((p) => p.name).join(', ')
      setTitle('')
      setVisibility('private')
      setAssignees([])
      setKeepMine(false)
      onCreated(created)
      if (sentTo !== '') showToast({ tone: 'success', text: t('tasks.sent', { name: sentTo }) })
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
          hint={assignees.length > 0 ? undefined : t('tasks.assignHint')}
          selected={assignees}
          onSelect={(person) => setAssignees([...assignees, person])}
          onRemove={(removed) => {
            const rest = assignees.filter((p) => p.id !== removed.id)
            setAssignees(rest)
            if (rest.length === 0) setKeepMine(false)
          }}
          exclude={meId === undefined ? [] : [meId]}
          full={assignees.length >= limit}
          fullText={t('tasks.manyAssignees', { count: limit })}
        />
      </div>
      {assignees.length > 0 && (
        <label class="new-task__keep" for={keepId}>
          <input id={keepId} type="checkbox" checked={keepMine} disabled={!keepMine && assignees.length >= MAX_ASSIGNEES} onChange={(event) => setKeepMine(event.currentTarget.checked)} />
          {t('tasks.keepMine')}
        </label>
      )}
      {assignees.length > 0 && (
        <p class="new-task__inbox">
          {assignees.length === 1 ? t('tasks.goesToInbox', { name: assignees[0].name }) : t('tasks.goesToInboxMany')}
        </p>
      )}
      {mine &&
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
