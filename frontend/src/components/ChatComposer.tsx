/**
 * The composer of a channel or of a thread: text (a draft per place), files (picked,
 * pasted or dropped: checked, then uploaded with their progress), typing whispers, and
 * the optimistic send. A message may be files only, as the server allows.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Channel } from '../api/types.ts'
import { t } from '../i18n/index.ts'
import { useLocale } from '../i18n/useLocale.ts'
import { ACCEPT } from '../lib/files.ts'
import { MAX_BODY, charCount, trimBody } from '../lib/text.ts'
import type { Chat } from '../store/chat.ts'
import { isDirect } from '../store/channels.ts'
import { channelKey, threadKey } from '../store/messages.ts'
import { drafts, showToast } from '../store/ui.ts'
import { Composer } from './ui/Composer.tsx'
import { FileChip } from './ui/FileChip.tsx'
import { uploadErrorText } from '../lib/files.ts'
import { useChat } from './chatContext.ts'

/** The uploads tray of a composer: the channel's, or a thread's. */
export const trayKey = (channelId: number, parentId: number | null) => (parentId ? threadKey(parentId) : channelKey(channelId))

/** Checks and uploads files for a composer; what is refused before sending anything is said at once. */
export function addFiles(chat: Chat, channelId: number, parentId: number | null, files: readonly File[]): void {
  if (files.length === 0) return
  const problems = chat.uploads.add(trayKey(channelId, parentId), channelId, files)
  if (problems.length > 0) showToast({ tone: 'error', text: problems.join(' '), key: 'upload-check' }, 9000)
}

type Props = {
  channel: Channel
  /** "#general" or the conversation's names, for the placeholder. */
  label: string
  /** Replying in this thread. */
  parentId?: number | null
  onSent?: () => void
}

export function ChatComposer({ channel, label, parentId = null, onSent }: Props) {
  // Its props stay the same when the language changes: re-rendered by useLocale (see Workspace).
  useLocale()
  const chat = useChat()
  const key = trayKey(channel.id, parentId)
  const [value, setValue] = useState(() => drafts.get(key) ?? '')
  const tray = chat.uploads.tray(key).value
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const busy = tray.some((item) => item.status === 'uploading' || item.status === 'scanning')
  const ready = tray.some((item) => item.status === 'done')

  useEffect(() => {
    // Ready to type on a desktop; on a touch screen, opening the keyboard uninvited is rude.
    if (globalThis.matchMedia?.('(pointer: fine)').matches) input.current?.focus({ preventScroll: true })
  }, [key])

  // Leaving the place: whoever saw "typing…" can stop showing it.
  useEffect(() => () => chat.typing.stopped(channel.id, parentId), [chat, channel.id, parentId])

  const onInput = (next: string) => {
    setValue(next)
    if (next) drafts.set(key, next)
    else drafts.delete(key)
    if (trimBody(next) !== '') chat.typing.typed(channel.id, parentId)
  }

  const send = () => {
    const body = trimBody(value)
    const files = chat.uploads.attached(key)
    if ((body === '' && files.length === 0) || charCount(body) > MAX_BODY || chat.uploads.busy(key)) return
    chat.send(channel.id, body, { parentId, files })
    chat.uploads.clearAttached(key)
    chat.typing.stopped(channel.id, parentId)
    onInput('')
    onSent?.()
    input.current?.focus()
  }

  const onPaste = (event: ClipboardEvent) => {
    const files = [...(event.clipboardData?.files ?? [])]
    if (files.length === 0) return
    // A copied image: the file, not its name as text (text pasted along with it still goes in).
    if (!event.clipboardData?.types.includes('text/plain')) event.preventDefault()
    addFiles(chat, channel.id, parentId, files)
  }

  let placeholder: string | undefined
  if (parentId) placeholder = t('composer.placeholderThread')
  else if (isDirect(channel)) placeholder = t('composer.placeholderDirect', { name: label })

  return (
    <>
      <Composer
        channel={label}
        placeholder={placeholder}
        value={value}
        onInput={onInput}
        onSend={send}
        onAttach={() => picker.current?.click()}
        hasFiles={ready}
        busy={busy}
        onPaste={onPaste}
        onBlur={() => chat.typing.stopped(channel.id, parentId)}
        maxLength={MAX_BODY}
        inputRef={input}
        files={
          tray.length > 0 &&
          tray.map((item) => (
            <FileChip
              key={item.id}
              name={item.name}
              bytes={item.size}
              state={item.status === 'done' ? 'ready' : item.status === 'failed' ? 'error' : item.status}
              progress={item.progress}
              error={item.error ? uploadErrorText(item.error, item.name) : undefined}
              onRetry={item.status === 'failed' ? () => chat.uploads.retry(key, item.id) : undefined}
              onRemove={() => chat.uploads.cancel(key, item.id)}
            />
          ))
        }
      />
      <input
        ref={picker}
        class="composer__picker"
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])]
          event.currentTarget.value = ''
          addFiles(chat, channel.id, parentId, files)
        }}
      />
    </>
  )
}
