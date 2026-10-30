/**
 * "New message": pick one to seven people, then open the conversation with exactly them
 * (the server answers with the existing one, 200, or a new one, 201; either way it is
 * listed and opened).
 */
import { useState } from 'preact/hooks'
import { isApiError } from '../api/client.ts'
import type { UserSummary } from '../api/types.ts'
import { plural, t } from '../i18n/index.ts'
import { channelPath, navigate } from '../router.ts'
import { me } from '../store/session.ts'
import { Button } from './ui/Button.tsx'
import { Dialog } from './ui/Dialog.tsx'
import { useChat } from './chatContext.ts'
import { PeoplePicker } from './PeoplePicker.tsx'

/** backend DirectChannelController::MAX_PARTICIPANTS, minus me. */
export const MAX_OTHERS = 7

export function NewMessageDialog({ onClose }: { onClose: () => void }) {
  const chat = useChat()
  const [people, setPeople] = useState<UserSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = async () => {
    if (people.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      const { channel } = await chat.openConversation(people.map((p) => p.id))
      onClose()
      navigate(channelPath(channel.id))
    } catch (failure) {
      setBusy(false)
      if (isApiError(failure, 'rate_limited')) return
      const code = isApiError(failure) ? failure.code : ''
      setError(t(code === 'invalid_participants' ? 'dm.error.invalid_participants' : code === 'invalid_participant_count' ? 'dm.error.invalid_participant_count' : 'dm.error.generic'))
    }
  }

  return (
    <Dialog
      title={t('dm.title')}
      onClose={onClose}
      onSubmit={() => void open()}
      class="dialog--people"
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={people.length === 0 || busy}>
            {t('dm.start')}
          </Button>
        </>
      }
    >
      <PeoplePicker
        label={t('dm.to')}
        placeholder={t('people.placeholder')}
        hint={people.length >= MAX_OTHERS ? plural('dm.max', MAX_OTHERS) : t('dm.hint')}
        selected={people}
        exclude={me.value ? [me.value.id] : []}
        full={people.length >= MAX_OTHERS}
        disabled={busy}
        onSelect={(person) => {
          setError(null)
          setPeople((current) => (current.length >= MAX_OTHERS || current.some((p) => p.id === person.id) ? current : [...current, person]))
        }}
        onRemove={(person) => setPeople((current) => current.filter((p) => p.id !== person.id))}
      />
      {error && (
        <p class="field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
