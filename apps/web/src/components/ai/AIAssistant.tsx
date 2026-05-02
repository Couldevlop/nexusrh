import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Send, Sparkles, Trash2, FileText } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { useUIStore } from '@/stores/uiStore'
import { useAIStore } from '@/stores/aiStore'
import { useAIChat } from '@/hooks/useAI'
import { useAuthStore } from '@/stores/authStore'
import { formatRelativeDate, cn } from '@/lib/utils'
import { useLocation } from 'react-router-dom'

const QUICK_SUGGESTIONS: Record<string, string[]> = {
  '/employees': [
    'Analyser le risque de turnover de l\'équipe',
    'Générer un contrat CDI type',
    'Expliquer les règles de période d\'essai',
  ],
  '/payroll': [
    'Calculer l\'impact d\'une augmentation de 3%',
    'Expliquer la rubrique CSG déductible',
    'Quelles sont les obligations DSN ce mois-ci ?',
  ],
  '/absences': [
    'Calcul des congés payés proratisés',
    'Règles pour le congé paternité 2024',
    'Que faire si un salarié dépasse son solde RTT ?',
  ],
  '/recruitment': [
    'Rédiger une offre d\'emploi inclusive',
    'Quelles questions sont interdites en entretien ?',
    'Délai maximum pour un CDD de remplacement',
  ],
  default: [
    'Résumer la législation sur le télétravail',
    'Générer un document RH',
    'Analyser les indicateurs RH du moment',
  ],
}

export function AIAssistant() {
  const { aiDrawerOpen, setAIDrawerOpen } = useUIStore()
  const { messages, isStreaming, currentStreamText, clearConversation } = useAIStore()
  const { sendMessage } = useAIChat()
  const { user } = useAuthStore()
  const location = useLocation()
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const pageSuggestions =
    QUICK_SUGGESTIONS[Object.keys(QUICK_SUGGESTIONS).find((k) =>
      location.pathname.startsWith(k)
    ) ?? 'default'] ?? QUICK_SUGGESTIONS['default'] ?? []

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, currentStreamText])

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return
    const message = input
    setInput('')
    await sendMessage(message, { currentPage: location.pathname })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      handleSend()
    }
  }

  return (
    <AnimatePresence>
      {aiDrawerOpen && (
        <>
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/20 z-40"
            onClick={() => setAIDrawerOpen(false)}
          />

          {/* Drawer */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed right-0 top-0 bottom-0 w-[480px] bg-white shadow-2xl z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b bg-gradient-to-r from-indigo-600 to-purple-600 text-white">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="font-semibold">NexusRH AI</h2>
                  <div className="flex items-center gap-1 text-xs text-white/80">
                    <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                    En ligne — Claude claude-sonnet-4-20250514
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={clearConversation}
                  className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
                  title="Effacer la conversation"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setAIDrawerOpen(false)}
                  className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 && (
                <div className="space-y-4">
                  <div className="text-center py-4">
                    <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Sparkles className="w-6 h-6 text-indigo-600" />
                    </div>
                    <p className="text-sm text-gray-600">
                      Bonjour {user?.firstName}! Comment puis-je vous aider aujourd'hui ?
                    </p>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
                      Suggestions rapides
                    </p>
                    {pageSuggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => {
                          setInput(suggestion)
                          textareaRef.current?.focus()
                        }}
                        className="w-full text-left text-sm px-3 py-2 bg-gray-50 hover:bg-indigo-50 hover:text-indigo-700 rounded-lg transition-colors border border-gray-200 hover:border-indigo-200"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    'flex gap-3',
                    message.role === 'user' ? 'flex-row-reverse' : 'flex-row'
                  )}
                >
                  <div
                    className={cn(
                      'w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold',
                      message.role === 'user'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-gray-200 text-gray-600'
                    )}
                  >
                    {message.role === 'user' ? (
                      `${user?.firstName?.charAt(0)}${user?.lastName?.charAt(0)}`
                    ) : (
                      <Sparkles className="w-3.5 h-3.5" />
                    )}
                  </div>
                  <div
                    className={cn(
                      'max-w-[85%] rounded-2xl px-4 py-3 text-sm',
                      message.role === 'user'
                        ? 'bg-indigo-600 text-white rounded-tr-sm'
                        : 'bg-gray-100 text-gray-800 rounded-tl-sm'
                    )}
                  >
                    {message.role === 'assistant' ? (
                      <ReactMarkdown className="prose prose-sm max-w-none prose-headings:text-gray-800 prose-p:my-1">
                        {message.content}
                      </ReactMarkdown>
                    ) : (
                      <p>{message.content}</p>
                    )}
                    <p
                      className={cn(
                        'text-xs mt-1 opacity-60',
                        message.role === 'user' ? 'text-right' : ''
                      )}
                    >
                      {formatRelativeDate(message.createdAt)}
                    </p>
                  </div>
                </div>
              ))}

              {/* Stream en cours */}
              {isStreaming && currentStreamText && (
                <div className="flex gap-3">
                  <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                    <Sparkles className="w-3.5 h-3.5 text-gray-600" />
                  </div>
                  <div className="max-w-[85%] rounded-2xl rounded-tl-sm px-4 py-3 bg-gray-100">
                    <ReactMarkdown className="prose prose-sm max-w-none text-sm">
                      {currentStreamText}
                    </ReactMarkdown>
                    <span className="inline-flex gap-0.5 mt-1">
                      {[0, 1, 2].map((i) => (
                        <motion.span
                          key={i}
                          className="w-1 h-1 bg-gray-400 rounded-full"
                          animate={{ y: [0, -3, 0] }}
                          transition={{
                            duration: 0.6,
                            repeat: Infinity,
                            delay: i * 0.1,
                          }}
                        />
                      ))}
                    </span>
                  </div>
                </div>
              )}

              {isStreaming && !currentStreamText && (
                <div className="flex gap-3">
                  <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center">
                    <Sparkles className="w-3.5 h-3.5 text-gray-600 animate-pulse" />
                  </div>
                  <div className="px-4 py-3 bg-gray-100 rounded-2xl rounded-tl-sm">
                    <span className="inline-flex gap-0.5">
                      {[0, 1, 2].map((i) => (
                        <motion.span
                          key={i}
                          className="w-1.5 h-1.5 bg-gray-400 rounded-full"
                          animate={{ y: [0, -4, 0] }}
                          transition={{
                            duration: 0.6,
                            repeat: Infinity,
                            delay: i * 0.15,
                          }}
                        />
                      ))}
                    </span>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="border-t p-4 space-y-2">
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Posez votre question RH... (⌘+Entrée pour envoyer)"
                    rows={2}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    disabled={isStreaming}
                    style={{ maxHeight: 120, overflow: 'auto' }}
                  />
                </div>
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isStreaming}
                  className="px-3 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors self-end"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button className="flex items-center gap-1 text-xs text-gray-400 hover:text-indigo-600 transition-colors">
                  <FileText className="w-3 h-3" />
                  Générer un document
                </button>
                <span className="text-gray-200">|</span>
                <span className="text-xs text-gray-400">
                  Propulsé par Claude claude-sonnet-4-20250514 (Anthropic)
                </span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
