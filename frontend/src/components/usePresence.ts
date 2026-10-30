import { useContext, useEffect } from 'preact/hooks'
import { ChatContext } from './chatContext.ts'

/** The people this component shows: their presence is polled while it is on screen (nothing without a chat). */
export function useTrackPresence(key: string, ids: readonly number[]): void {
  const chat = useContext(ChatContext)
  const signature = [...new Set(ids)].sort((a, b) => a - b).join(',')
  useEffect(() => {
    if (!chat) return
    chat.presence.track(key, signature === '' ? [] : signature.split(',').map(Number))
    return () => chat.presence.untrack(key)
  }, [chat, key, signature])
}
