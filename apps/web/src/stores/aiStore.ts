import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

interface AIState {
  messages: AIMessage[]
  isStreaming: boolean
  currentStreamText: string
  addMessage: (message: Omit<AIMessage, 'id' | 'createdAt'>) => void
  appendStreamChunk: (chunk: string) => void
  finalizeStream: () => void
  clearConversation: () => void
  setStreaming: (streaming: boolean) => void
}

export const useAIStore = create<AIState>()(
  persist(
    (set, get) => ({
      messages: [],
      isStreaming: false,
      currentStreamText: '',

      addMessage: (message) => {
        const newMessage: AIMessage = {
          ...message,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        }
        set((s) => ({
          messages: [...s.messages, newMessage],
        }))
      },

      appendStreamChunk: (chunk) => {
        set((s) => ({ currentStreamText: s.currentStreamText + chunk }))
      },

      finalizeStream: () => {
        const { currentStreamText } = get()
        if (currentStreamText) {
          const assistantMessage: AIMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: currentStreamText,
            createdAt: new Date().toISOString(),
          }
          set((s) => ({
            messages: [...s.messages, assistantMessage],
            currentStreamText: '',
            isStreaming: false,
          }))
        }
      },

      clearConversation: () => set({ messages: [], currentStreamText: '' }),

      setStreaming: (streaming) => set({ isStreaming: streaming }),
    }),
    {
      name: 'nexusrh-ai',
      partialize: (state) => ({
        messages: state.messages.slice(-50), // Garder les 50 derniers messages
      }),
    }
  )
)
