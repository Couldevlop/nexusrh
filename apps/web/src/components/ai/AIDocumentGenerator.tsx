import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileText, X, Download, Copy, Check, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { useGenerateDocument } from '@/hooks/useAI'

const DOCUMENT_TYPES = [
  { id: 'cdi', label: 'Contrat CDI', icon: '📄' },
  { id: 'cdd', label: 'Contrat CDD', icon: '📋' },
  { id: 'internship', label: 'Convention de stage', icon: '🎓' },
  { id: 'job_offer', label: "Offre d'emploi", icon: '💼' },
  { id: 'warning', label: 'Avertissement', icon: '⚠️' },
  { id: 'termination', label: 'Lettre de licenciement', icon: '📮' },
  { id: 'conventional_termination', label: 'Rupture conventionnelle', icon: '🤝' },
  { id: 'certificate', label: 'Certificat de travail', icon: '🏆' },
  { id: 'amendment', label: 'Avenant au contrat', icon: '✏️' },
]

interface AIDocumentGeneratorProps {
  isOpen: boolean
  onClose: () => void
  employeeContext?: Record<string, unknown>
}

export function AIDocumentGenerator({ isOpen, onClose, employeeContext }: AIDocumentGeneratorProps) {
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [additionalContext, setAdditionalContext] = useState('')
  const [generatedDoc, setGeneratedDoc] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const { mutate: generateDocument, isPending } = useGenerateDocument()

  const handleGenerate = () => {
    if (!selectedType) return
    generateDocument(
      {
        type: selectedType,
        data: {
          ...employeeContext,
          additionalInstructions: additionalContext,
        },
      },
      {
        onSuccess: (content: string) => {
          setGeneratedDoc(content)
        },
      }
    )
  }

  const handleCopy = async () => {
    if (!generatedDoc) return
    await navigator.clipboard.writeText(generatedDoc)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    if (!generatedDoc) return
    const blob = new Blob([generatedDoc], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedType ?? 'document'}-${Date.now()}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col z-10"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-indigo-100 rounded-lg flex items-center justify-center">
                  <FileText className="w-4 h-4 text-indigo-600" />
                </div>
                <div>
                  <h2 className="font-semibold text-gray-900">Générer un document RH</h2>
                  <p className="text-xs text-gray-500">Propulsé par NexusRH AI</p>
                </div>
              </div>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {!generatedDoc ? (
                <div className="space-y-4">
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-3">
                      Type de document
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {DOCUMENT_TYPES.map((doc) => (
                        <button
                          key={doc.id}
                          onClick={() => setSelectedType(doc.id)}
                          className={`p-3 rounded-lg border text-left transition-all ${
                            selectedType === doc.id
                              ? 'border-indigo-500 bg-indigo-50'
                              : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          <span className="text-xl">{doc.icon}</span>
                          <p className="text-xs font-medium text-gray-700 mt-1">{doc.label}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-medium text-gray-700 block mb-1.5">
                      Instructions supplémentaires (optionnel)
                    </label>
                    <textarea
                      value={additionalContext}
                      onChange={(e) => setAdditionalContext(e.target.value)}
                      placeholder="Ex: Inclure une clause de non-concurrence, durée de 12 mois, période d'essai de 3 mois..."
                      rows={3}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                    />
                  </div>
                </div>
              ) : (
                <div className="prose prose-sm max-w-none">
                  <ReactMarkdown>{generatedDoc}</ReactMarkdown>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="p-5 border-t bg-gray-50 flex items-center justify-between rounded-b-2xl">
              {!generatedDoc ? (
                <>
                  <p className="text-xs text-gray-500">
                    Le document sera conforme au droit du travail français
                  </p>
                  <button
                    onClick={handleGenerate}
                    disabled={!selectedType || isPending}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                  >
                    {isPending ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Génération...</>
                    ) : (
                      <><FileText className="w-4 h-4" /> Générer</>
                    )}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => { setGeneratedDoc(null); setSelectedType(null) }}
                    className="text-sm text-gray-600 hover:text-gray-800"
                  >
                    ← Recommencer
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={handleCopy}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                    >
                      {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                      {copied ? 'Copié !' : 'Copier'}
                    </button>
                    <button
                      onClick={handleDownload}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                    >
                      <Download className="w-4 h-4" />
                      Télécharger
                    </button>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
