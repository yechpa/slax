/** Who is typing in a channel or a thread, by name (an unknown sender is "someone"). */
import { t } from '../i18n/index.ts'
import { useLocale } from '../i18n/useLocale.ts'
import { personName } from '../store/people.ts'
import { TypingIndicator } from './ui/TypingIndicator.tsx'
import { useChat } from './chatContext.ts'

export function Typing({ channelId, parentId = null }: { channelId: number; parentId?: number | null }) {
  // Its props stay the same when the language changes (see Workspace).
  useLocale()
  const chat = useChat()
  const names = chat.typing.typers(channelId, parentId).value.map((id) => personName(id) ?? t('typing.someone'))
  return <TypingIndicator names={names} />
}
