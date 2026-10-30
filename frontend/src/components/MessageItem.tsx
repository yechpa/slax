/** One timeline entry: a message, a tombstone, or one of my messages still on its way. */
import type { Message as ApiMessage } from '../api/types.ts'
import { formatTime } from '../i18n/format.ts'
import { t } from '../i18n/index.ts'
import type { Entry } from '../store/merge.ts'
import { me } from '../store/session.ts'
import { Button } from './ui/Button.tsx'
import { userHue } from './ui/hue.ts'
import { Message } from './ui/Message.tsx'
import { Tombstone } from './ui/Tombstone.tsx'
import { RichText } from './RichText.tsx'

export const stamp = (iso: string) => ({ iso, label: formatTime(new Date(iso)) })

type Props = {
  entry: Entry
  /** Same author, a moment after the previous message: no avatar or header. */
  compact?: boolean
  onRetry?: (clientId: string) => void
  onDiscard?: (clientId: string) => void
}

export function MessageItem({ entry, compact = false, onRetry, onDiscard }: Props) {
  if (entry.kind === 'server') return <ServerMessage message={entry.message} compact={compact} />

  const author = me.value
  const failed = entry.status === 'failed'
  return (
    <Message
      author={author?.name ?? ''}
      hue={userHue(String(author?.id ?? 0))}
      time={stamp(entry.createdAt)}
      compact={compact}
      busy={!failed}
      class={failed ? 'message--failed' : 'message--pending'}
      footer={
        failed && (
          <>
            <span class="message__error" role="alert">
              {t(entry.error === 'rate_limited' ? 'error.sendRateLimited' : 'error.sendFailed')}
            </span>
            <Button variant="quiet" size="sm" onClick={() => onRetry?.(entry.clientId)}>
              {t('action.retry')}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => onDiscard?.(entry.clientId)}>
              {t('action.discard')}
            </Button>
          </>
        )
      }
    >
      <RichText text={entry.body} />
    </Message>
  )
}

function ServerMessage({ message, compact }: { message: ApiMessage; compact: boolean }) {
  if (message.deleted) return <Tombstone time={stamp(message.created_at)} />
  return (
    <Message
      author={message.user.name}
      hue={userHue(String(message.user.id))}
      time={stamp(message.created_at)}
      edited={message.edited_at !== null}
      compact={compact}
    >
      <RichText text={message.body} />
    </Message>
  )
}
