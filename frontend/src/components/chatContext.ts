import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import type { Chat } from '../store/chat.ts'

export const ChatContext = createContext<Chat | null>(null)

export function useChat(): Chat {
  const chat = useContext(ChatContext)
  if (!chat) throw new Error('useChat() outside of <ChatContext.Provider>')
  return chat
}
