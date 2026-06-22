import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { Bot, X, Send, Loader2, ChevronDown, AlertCircle, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import MarkdownMessage from './MarkdownMessage'

// Nom d'affichage du fournisseur IA réellement utilisé (le chat peut tourner
// sur Mistral OU Claude selon la configuration tenant/plateforme).
const PROVIDER_LABELS: Record<string, string> = {
  mistral: 'Mistral AI',
  claude:  'Claude (Anthropic)',
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

const SUGGESTION_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager'] as const

export default function AiChat() {
  const { t } = useTranslation('dashboard')
  const user = useAuthStore(s => s.user)
  const tenantConfig = useAuthStore(s => s.tenantConfig)
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const { data: statusData } = useQuery<{ available: boolean; provider?: 'mistral' | 'claude' | null; message: string }>({
    queryKey: ['ai-status'],
    queryFn: () => api.get('/ai/status').then(r => r.data),
    staleTime: 60_000,
  })

  const aiAvailable = statusData?.available ?? false
  const providerLabel = statusData?.provider ? (PROVIDER_LABELS[statusData.provider] ?? 'IA') : 'IA'
  const suggestionRole = SUGGESTION_ROLES.includes((user?.role ?? '') as typeof SUGGESTION_ROLES[number])
    ? (user?.role as typeof SUGGESTION_ROLES[number])
    : 'hr_manager'
  const suggestions = t(`aiChat.suggestions.${suggestionRole}`, { returnObjects: true }) as string[]

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage(text?: string) {
    const content = (text ?? input).trim()
    if (!content || streaming || !aiAvailable) return

    setInput('')
    const newMessages: Message[] = [...messages, { role: 'user', content }]
    setMessages(newMessages)
    setStreaming(true)

    // Ajouter message assistant vide (streaming)
    setMessages(prev => [...prev, { role: 'assistant', content: '', streaming: true }])

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL ?? '/api'}/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${useAuthStore.getState().token}`,
        },
        body: JSON.stringify({
          messages: newMessages,
          context: {
            tenantName: tenantConfig?.name,
            userRole: user?.role,
          },
        }),
      })

      if (!response.ok) throw new Error(t('aiChat.error'))

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let assistantContent = ''

      while (reader) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value)
        const lines = chunk.split('\n')
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6)) as { text?: string; done?: boolean; error?: string }
            if (data.error) { assistantContent += `\n\n❌ ${data.error}`; break }
            if (data.text) {
              assistantContent += data.text
              setMessages(prev => {
                const next = [...prev]
                const last = next[next.length - 1]
                if (last?.role === 'assistant') last.content = assistantContent
                return next
              })
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : t('aiChat.connectionError')
      setMessages(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.role === 'assistant') last.content = `❌ ${errMsg}`
        return next
      })
    } finally {
      setMessages(prev => prev.map(m => ({ ...m, streaming: false })))
      setStreaming(false)
    }
  }

  if (!user || user.role === 'employee' || user.role === 'super_admin' || user.role === 'readonly') {
    return null
  }

  return (
    <>
      {/* Bouton flottant */}
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          'fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition-all',
          'bg-primary text-primary-foreground hover:opacity-90',
          open && 'rotate-12',
        )}
        title={t('aiChat.fabTitle')}
      >
        {open ? <X className="h-6 w-6" /> : <Sparkles className="h-6 w-6" />}
      </button>

      {/* Fenêtre chat */}
      {open && (
        <div className="fixed bottom-24 right-6 z-50 flex flex-col w-96 max-h-[600px] rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-border bg-primary px-4 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20">
              <Bot className="h-4 w-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white">{t('aiChat.headerTitle')}</p>
              <p className="text-xs text-white/70 truncate">
                {aiAvailable
                  ? t('aiChat.poweredBy', { provider: providerLabel, tenant: tenantConfig?.name ?? '' })
                  : t('aiChat.limitedMode')}
              </p>
            </div>
            <button onClick={() => setOpen(false)} className="text-white/70 hover:text-white">
              <ChevronDown className="h-5 w-5" />
            </button>
          </div>

          {/* IA non disponible */}
          {!aiAvailable && (
            <div className="flex items-start gap-3 bg-amber-50 p-4 border-b border-amber-200">
              <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-800">
                {statusData?.message ?? t('aiChat.unavailableDefault')}
              </p>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-auto p-4 space-y-3 min-h-0">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground text-center">
                  {t('aiChat.emptyPrompt')}
                </p>
                <div className="space-y-2">
                  {suggestions.map(s => (
                    <button
                      key={s}
                      onClick={() => aiAvailable && sendMessage(s)}
                      disabled={!aiAvailable}
                      className="w-full text-left rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn(
                  'max-w-[85%] rounded-2xl px-3 py-2 text-sm',
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-sm'
                    : 'bg-muted rounded-bl-sm',
                )}>
                  {msg.content
                    ? (msg.role === 'assistant'
                        // R\u00e9ponse IA : rendu markdown (titres, listes, tableaux, gras\u2026)
                        ? <MarkdownMessage content={msg.content} />
                        // Message utilisateur : texte brut, sauts de ligne pr\u00e9serv\u00e9s
                        : msg.content.split('\n').map((line, j) => (
                            <p key={j} className={j > 0 ? 'mt-1' : ''}>{line || '\u00a0'}</p>
                          )))
                    : msg.streaming && (
                        <span className="flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span className="text-xs opacity-60">{t('aiChat.writing')}</span>
                        </span>
                      )
                  }
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-border p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage() } }}
                placeholder={aiAvailable ? t('aiChat.inputPlaceholder') : t('aiChat.inputPlaceholderUnavailable')}
                disabled={!aiAvailable || streaming}
                rows={1}
                className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none disabled:opacity-50"
                style={{ maxHeight: '80px', overflowY: 'auto' }}
              />
              <button
                onClick={() => void sendMessage()}
                disabled={!input.trim() || !aiAvailable || streaming}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                {streaming
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Send className="h-4 w-4" />
                }
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground text-center">
              {t('aiChat.footer')}
            </p>
          </div>
        </div>
      )}
    </>
  )
}
