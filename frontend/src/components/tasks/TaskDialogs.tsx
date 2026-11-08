/** The task dialog open over the workspace, if any (`taskDialog`): every way out clears it. */
import { useLocale } from '../../i18n/useLocale.ts'
import { taskDialog } from '../../store/tasks.ts'
import { AssignDialog } from './AssignDialog.tsx'
import { DeleteListDialog, NewListDialog, RenameListDialog } from './ListDialogs.tsx'
import { MoveTaskDialog } from './MoveTaskDialog.tsx'
import { PeopleTasksDialog } from './PeopleTasksDialog.tsx'

const close = () => {
  taskDialog.value = null
}

export function TaskDialogs() {
  // Prop-less: without it, an open dialog would keep the previous language.
  useLocale()
  const dialog = taskDialog.value
  if (!dialog) return null
  switch (dialog.kind) {
    case 'new-list':
      return <NewListDialog onClose={close} />
    case 'rename-list':
      return <RenameListDialog list={dialog.list} onClose={close} />
    case 'delete-list':
      return <DeleteListDialog list={dialog.list} onClose={close} />
    case 'move':
      return <MoveTaskDialog task={dialog.task} onClose={close} />
    case 'assign':
      return <AssignDialog task={dialog.task} also={dialog.also} onClose={close} />
    case 'people':
      return <PeopleTasksDialog onClose={close} />
  }
}
