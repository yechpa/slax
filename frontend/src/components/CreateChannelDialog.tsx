/**
 * "Create a channel": a name the server will accept (checked as you type, with the
 * reason when it is not), public or private, an optional topic. The new channel is
 * listed, subscribed and opened.
 */
import { useRef, useState } from 'preact/hooks'
import { isApiError } from '../api/client.ts'
import { t } from '../i18n/index.ts'
import { CHANNEL_NAME_MAX, channelNameProblem, normalizeChannelName } from '../lib/channelName.ts'
import { channelPath, navigate } from '../router.ts'
import { showToast } from '../store/ui.ts'
import { Button } from './ui/Button.tsx'
import { Dialog } from './ui/Dialog.tsx'
import { Segmented } from './ui/Segmented.tsx'
import { TextField } from './ui/TextField.tsx'
import { useChat } from './chatContext.ts'

export const TOPIC_MAX = 250

export function CreateChannelDialog({ onClose }: { onClose: () => void }) {
  const chat = useChat()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'public' | 'private'>('public')
  const [topic, setTopic] = useState('')
  const [tried, setTried] = useState(false)
  const [taken, setTaken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameField = useRef<HTMLInputElement>(null)
  const problem = channelNameProblem(name)
  // Said as soon as there is something to say about it; "empty" only once Create was tried.
  const nameError = taken === name ? t('channel.create.error.taken') : problem && (problem !== 'empty' || tried) ? t(`channel.create.error.${problem}`) : undefined

  const create = async () => {
    setTried(true)
    if (problem || busy) {
      nameField.current?.focus()
      return
    }
    setBusy(true)
    try {
      const channel = await chat.createChannel({ name, kind, topic: topic.trim() === '' ? null : topic.trim() })
      onClose()
      navigate(channelPath(channel.id))
      showToast({ tone: 'success', text: t('channel.created', { channel: `#${channel.name}` }), key: 'create' })
    } catch (error) {
      setBusy(false)
      if (isApiError(error, 'validation') && error.fields.name) {
        setTaken(name)
        nameField.current?.focus()
      } else if (!isApiError(error, 'rate_limited')) showToast({ tone: 'error', text: t('error.createFailed'), key: 'create' })
    }
  }

  return (
    <Dialog
      title={t('channel.create.title')}
      onClose={onClose}
      onSubmit={() => void create()}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {t('channel.create.submit')}
          </Button>
        </>
      }
    >
      <TextField
        ref={nameField}
        label={t('channel.create.name')}
        hint={t('channel.create.nameHint')}
        error={nameError}
        value={name}
        maxLength={CHANNEL_NAME_MAX + 10}
        autocomplete="off"
        spellcheck={false}
        dir="auto"
        class="field--channel-name"
        onInput={(event) => {
          const field = event.currentTarget
          const next = normalizeChannelName(field.value)
          if (next !== field.value) {
            // Same length: the caret stays where it was.
            const at = field.selectionStart
            field.value = next
            if (at !== null) field.setSelectionRange(at, at)
          }
          setName(next)
        }}
      />
      <Segmented<'public' | 'private'>
        legend={t('channel.create.visibility')}
        value={kind}
        onChange={setKind}
        options={[
          { value: 'public', label: t('channel.create.public') },
          { value: 'private', label: t('channel.create.private') },
        ]}
      />
      <p class="field__hint">{t(kind === 'public' ? 'channel.create.publicHint' : 'channel.create.privateHint')}</p>
      <TextField label={t('channel.create.topic')} value={topic} maxLength={TOPIC_MAX} onInput={(event) => setTopic(event.currentTarget.value)} />
    </Dialog>
  )
}
