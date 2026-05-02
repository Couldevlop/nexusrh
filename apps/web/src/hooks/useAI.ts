import { useMutation } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/authStore'
import { useAIStore } from '@/stores/aiStore'
import api from '@/lib/api'

const API_URL = import.meta.env['VITE_API_URL'] ?? 'http://localhost:4000'

export function useAIChat() {
  const { user, entityId } = useAuthStore()
  const { addMessage, appendStreamChunk, finalizeStream, setStreaming, messages } =
    useAIStore()

  const sendMessage = async (content: string, pageContext?: Record<string, unknown>) => {
    addMessage({ role: 'user', content })
    setStreaming(true)

    const accessToken = useAuthStore.getState().accessToken
    const context = {
      name: 'TechCorp SAS',
      employeeCount: 50,
      collectiveAgreement: 'syntec',
      country: 'FR',
      currentUser: {
        name: `${user?.firstName} ${user?.lastName}`,
        role: user?.role ?? 'employee',
      },
      pageContext,
    }

    const apiMessages = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content },
    ]

    try {
      const response = await fetch(`${API_URL}/ai/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ messages: apiMessages, context }),
      })

      if (!response.ok || !response.body) {
        throw new Error('Erreur de connexion à l\'assistant IA')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value)
        const lines = text.split('\n')

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') {
            finalizeStream()
            return
          }

          try {
            const parsed = JSON.parse(data) as {
              type: string
              text?: string
              message?: string
            }
            if (parsed.type === 'delta' && parsed.text) {
              appendStreamChunk(parsed.text)
            }
          } catch {
            // ignore parse errors
          }
        }
      }

      finalizeStream()
    } catch {
      setStreaming(false)
      addMessage({
        role: 'assistant',
        content: "Désolé, une erreur s'est produite. Veuillez réessayer.",
      })
    }
  }

  return { sendMessage }
}

export function useGenerateDocument() {
  return useMutation({
    mutationFn: async ({
      documentType,
      data,
    }: {
      documentType: string
      data: Record<string, unknown>
    }) => {
      const response = await api.post<{ data: { content: string } }>(
        '/ai/documents/generate',
        { documentType, data }
      )
      return response.data.data.content
    },
  })
}
