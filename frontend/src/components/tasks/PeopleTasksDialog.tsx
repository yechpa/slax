/**
 * "People's tasks": pick a colleague and their page (/tasks/u/:id) opens; the dialog is only
 * the way there, so choosing is the whole action.
 */
import { useRef } from 'preact/hooks'
import { t } from '../../i18n/index.ts'
import { useLocale } from '../../i18n/useLocale.ts'
import { navigate, tasksPath } from '../../router.ts'
import { me } from '../../store/session.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { PeoplePicker } from '../PeoplePicker.tsx'
import { tasksPane } from './pane.ts'

export function PeopleTasksDialog({ onClose }: { onClose: () => void }) {
  useLocale()
  const picked = useRef(false)
  return (
    <Dialog
      title={t('tasks.people')}
      onClose={onClose}
      class="dialog--people"
      returnFocus={() => (picked.current ? tasksPane() : undefined)}
      footer={
        <Button variant="quiet" onClick={onClose}>
          {t('action.cancel')}
        </Button>
      }
    >
      <PeoplePicker
        label={t('tasks.person')}
        placeholder={t('people.placeholder')}
        hint={t('tasks.people.hint')}
        selected={[]}
        exclude={me.value ? [me.value.id] : []}
        onSelect={(person) => {
          picked.current = true
          navigate(tasksPath({ kind: 'user', id: person.id }))
          onClose()
        }}
      />
    </Dialog>
  )
}
