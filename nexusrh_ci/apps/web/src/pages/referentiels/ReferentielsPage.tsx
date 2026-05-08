import { useState, useCallback, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, BookOpen, Scale, ChevronRight, Info } from 'lucide-react'
import { ArticleModal } from '@/components/referentiels/ArticleModal'
import { api } from '@/lib/api'

interface ArticleHit {
  article_id: string; article_numero: string; source: string
  convention_slug?: string; livre?: string; titre?: string
  chapitre?: string; titre_article: string; texte: string
  payroll_codes?: string[]; score: number
  highlight?: { texte?: string[]; titre_article?: string[] }
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

export default function ReferentielsPage() {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | 'code_travail_ci' | 'convention_collective'>('all')
  const [selectedArticle, setSelectedArticle] = useState<ArticleHit | null>(null)
  const dq = useDebounce(query, 350)
  const inputRef = useRef<HTMLInputElement>(null)

  const { data, isLoading } = useQuery<{ total: number; hits: ArticleHit[] }>({
    queryKey: ['referentiels', dq, source],
    queryFn: () => api.get('/referentiels/search', {
      params: { q: dq, ...(source !== 'all' && { source }), size: 20 },
    }).then((r: { data: { total: number; hits: ArticleHit[] } }) => r.data),
    enabled: dq.length >= 2,
    staleTime: 30_000,
  })

  const { data: tree } = useQuery<unknown[]>({
    queryKey: ['referentiels-tree'],
    queryFn: () => api.get('/referentiels/tree').then((r: { data: unknown[] }) => r.data),
    staleTime: 300_000,
  })

  const highlight = useCallback((hit: ArticleHit) => {
    const h = hit.highlight?.texte?.[0]
    return h ?? hit.texte.slice(0, 200) + '…'
  }, [])

  const sources = [
    { key: 'all', label: 'Tout' },
    { key: 'code_travail_ci', label: 'Code du Travail' },
    { key: 'convention_collective', label: 'Conventions' },
  ] as const

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden">
      {/* Sommaire */}
      <aside className="w-60 border-r bg-gray-50 overflow-y-auto p-4 shrink-0">
        <div className="flex items-center gap-2 mb-4 text-sm font-semibold text-gray-700">
          <Scale className="h-4 w-4 text-blue-600" />Sommaire
        </div>
        {(tree as any[] ?? []).map((src: any) => (
          <div key={src.key} className="mb-4">
            <button onClick={() => { setSource(src.key); setQuery('article') }}
              className="text-xs font-semibold text-blue-600 uppercase tracking-wide hover:underline text-left">
              {src.key === 'code_travail_ci' ? 'Code du Travail CI' : 'Conventions Collectives'}
            </button>
            {src.by_livre?.buckets?.map((livre: any) => (
              <p key={livre.key} className="ml-2 mt-1 text-xs text-gray-500 flex items-center gap-0.5">
                <ChevronRight className="h-3 w-3 shrink-0" />{livre.key}
              </p>
            ))}
          </div>
        ))}
      </aside>

      {/* Contenu principal */}
      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Référentiel Juridique CI</h1>
          <p className="text-gray-500 text-sm mb-5">Code du Travail ivoirien · Conventions Collectives · Recherche plein texte</p>

          {/* Barre de recherche */}
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input ref={inputRef} type="text"
              className="w-full pl-9 pr-4 py-2.5 text-base border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Ex: indemnité maternité, préavis licenciement, SMIG…"
              value={query} onChange={e => setQuery(e.target.value)} autoFocus />
          </div>

          {/* Filtres */}
          <div className="flex gap-2 mb-5">
            {sources.map(s => (
              <button key={s.key}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${source === s.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'}`}
                onClick={() => setSource(s.key)}>
                {s.label}
              </button>
            ))}
          </div>

          {/* Résultats */}
          {isLoading && (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <div key={i} className="h-28 bg-gray-100 rounded-lg animate-pulse" />)}
            </div>
          )}

          {data && dq.length >= 2 && (
            <p className="text-xs text-gray-400 mb-3">{data.total} résultat{data.total > 1 ? 's' : ''} pour « {dq} »</p>
          )}

          <div className="space-y-3">
            {data?.hits?.map((hit: ArticleHit) => (
              <article key={hit.article_id}
                className="border rounded-lg p-4 hover:border-blue-400 hover:bg-blue-50/30 transition-colors cursor-pointer"
                onClick={() => setSelectedArticle(hit)}>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${hit.source === 'code_travail_ci' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                    {hit.source === 'code_travail_ci' ? <><BookOpen className="h-3 w-3" />Code du Travail</> : <><Scale className="h-3 w-3" />Convention</>}
                  </span>
                  <span className="text-xs text-gray-400">{hit.article_numero}</span>
                  {hit.payroll_codes && hit.payroll_codes.length > 0 && (
                    <span className="text-xs text-blue-500 flex items-center gap-0.5"><Info className="h-3 w-3" />lié à la paie</span>
                  )}
                </div>
                <h3 className="font-medium text-sm text-gray-800 mb-1">{hit.titre_article}</h3>
                <p className="text-xs text-gray-500 line-clamp-3 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: highlight(hit) }} />
                {hit.livre && (
                  <p className="text-xs text-gray-400 mt-1 truncate">{hit.livre}{hit.titre ? ` › ${hit.titre}` : ''}</p>
                )}
              </article>
            ))}
          </div>

          {!query && (
            <div className="text-center text-gray-400 mt-16">
              <Scale className="h-12 w-12 mx-auto mb-3 opacity-20" />
              <p className="text-sm">Recherchez un terme juridique ou une rubrique de paie</p>
            </div>
          )}
        </div>
      </main>

      {selectedArticle && <ArticleModal article={selectedArticle} onClose={() => setSelectedArticle(null)} />}
    </div>
  )
}
