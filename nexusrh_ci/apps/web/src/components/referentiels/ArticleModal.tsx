import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X, BookOpen, Scale, ExternalLink, Info } from 'lucide-react'
import { api } from '@/lib/api'
import { useNavigate } from 'react-router-dom'

interface ArticleHit {
  article_id: string; article_numero: string; source: string
  convention_slug?: string; livre?: string; titre?: string
  chapitre?: string; titre_article: string; texte: string
  payroll_codes?: string[]
}

interface Props { article: ArticleHit; onClose: () => void }

export function ArticleModal({ article, onClose }: Props) {
  const navigate = useNavigate()
  const isCode = article.source === 'code_travail_ci'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-6">
          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${isCode ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                  {isCode ? <><BookOpen className="h-3 w-3" />Code du Travail CI</> : <><Scale className="h-3 w-3" />{article.convention_slug?.replace(/_/g, ' ') ?? 'Convention'}</>}
                </span>
                <span className="text-xs text-gray-500">{article.article_numero}</span>
              </div>
              <h2 className="text-base font-semibold text-gray-900">{article.titre_article}</h2>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 ml-4"><X className="h-5 w-5" /></button>
          </div>

          {/* Fil d'Ariane */}
          {article.livre && (
            <p className="text-xs text-gray-400 mb-3">
              {[article.livre, article.titre, article.chapitre].filter(Boolean).join(' › ')}
            </p>
          )}

          {/* Texte légal */}
          <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-blue-400 text-sm leading-relaxed whitespace-pre-wrap text-gray-700">
            {article.texte}
          </div>

          {/* Rubriques paie liées */}
          {article.payroll_codes && article.payroll_codes.length > 0 && (
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <span className="text-xs text-gray-500">Rubriques paie :</span>
              {article.payroll_codes.map(code => (
                <span key={code} className="text-xs font-mono bg-gray-100 px-2 py-0.5 rounded border">{code}</span>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-between mt-4 pt-3 border-t">
            <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Fermer</button>
            <button
              onClick={() => { navigate(`/referentiels?article=${article.article_id}`); onClose() }}
              className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
            >
              <ExternalLink className="h-3.5 w-3.5" />Voir dans le référentiel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Icône ℹ sur une ligne de bulletin → ouvre l'article de loi correspondant */
export function PayrollLineInfo({ payrollCode }: { payrollCode: string }) {
  const [open, setOpen] = useState(false)

  const { data: articles } = useQuery<ArticleHit[]>({
    queryKey: ['payroll-articles', payrollCode],
    queryFn: () => api.get(`/referentiels/payroll/${payrollCode}`).then((r: { data: ArticleHit[] }) => r.data),
    enabled: open,
    staleTime: 300_000,
  })

  return (
    <>
      <button title="Voir le texte de loi correspondant" onClick={() => setOpen(true)} className="text-blue-400 hover:text-blue-600 transition-colors">
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && articles?.[0] && <ArticleModal article={articles[0]} onClose={() => setOpen(false)} />}
    </>
  )
}
