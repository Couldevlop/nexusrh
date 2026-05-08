import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, BookOpen, Scale, ChevronRight, Info } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ArticleModal } from '@/components/referentiels/ArticleModal'
import { api } from '@/lib/axios'
import { useDebounce } from '@/hooks/useDebounce'

interface ArticleHit {
  article_id: string; article_numero: string; source: string
  convention_slug?: string; livre?: string; titre?: string
  chapitre?: string; titre_article: string; texte: string
  payroll_codes?: string[]; score: number
  highlight?: { texte?: string[]; titre_article?: string[] }
}

export default function ReferentielsPage() {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | 'code_travail_ci' | 'convention_collective'>('all')
  const [selectedArticle, setSelectedArticle] = useState<ArticleHit | null>(null)
  const debouncedQuery = useDebounce(query, 350)

  const { data, isLoading } = useQuery({
    queryKey: ['referentiels', debouncedQuery, source],
    queryFn: () => api.get('/referentiels/search', {
      params: {
        q: debouncedQuery,
        ...(source !== 'all' && { source }),
        size: 20,
      },
    }).then(r => r.data),
    enabled: debouncedQuery.length >= 2,
    staleTime: 30_000,
  })

  const { data: tree } = useQuery({
    queryKey: ['referentiels-tree'],
    queryFn: () => api.get('/referentiels/tree').then(r => r.data),
    staleTime: 300_000,
  })

  const highlight = useCallback((hit: ArticleHit) => {
    const h = hit.highlight
    if (h?.texte?.[0]) return h.texte[0]
    return hit.texte.slice(0, 200) + '…'
  }, [])

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden">
      {/* Sommaire hiérarchique — navigation cliquable */}
      <aside className="w-64 border-r bg-muted/30 overflow-y-auto p-4 shrink-0">
        <div className="flex items-center gap-2 mb-4 font-semibold text-sm">
          <Scale className="h-4 w-4 text-primary" />
          Sommaire
        </div>
        {(tree ?? []).map((src: any) => (
          <div key={src.key} className="mb-3">
            <button
              onClick={() => { setSource(src.key); setQuery('droit') }}
              className="text-xs font-semibold text-primary uppercase tracking-wide hover:underline text-left"
            >
              {src.key === 'code_travail_ci' ? 'Code du Travail CI' : 'Conventions Collectives'}
            </button>
            {src.by_livre?.buckets?.map((livre: any) => (
              <div key={livre.key} className="ml-2 mt-1">
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <ChevronRight className="h-3 w-3" />{livre.key}
                </span>
              </div>
            ))}
          </div>
        ))}
      </aside>

      {/* Zone principale */}
      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-2xl font-bold mb-1">Référentiel Juridique CI</h1>
          <p className="text-muted-foreground text-sm mb-5">
            Code du Travail ivoirien · Conventions Collectives · Recherche plein texte
          </p>

          {/* Barre de recherche Google-like */}
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9 text-base h-11"
              placeholder="Ex: indemnité maternité, préavis licenciement, SMIG…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              autoFocus
            />
          </div>

          {/* Filtres source */}
          <div className="flex gap-2 mb-6">
            {(['all', 'code_travail_ci', 'convention_collective'] as const).map(s => (
              <Button key={s} size="sm" variant={source === s ? 'default' : 'outline'}
                onClick={() => setSource(s)}>
                {s === 'all' ? 'Tout' : s === 'code_travail_ci' ? 'Code du Travail' : 'Conventions'}
              </Button>
            ))}
          </div>

          {/* Résultats */}
          {isLoading && (
            <div className="space-y-4">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-28 w-full rounded-lg" />)}
            </div>
          )}

          {data && (
            <p className="text-xs text-muted-foreground mb-3">
              {data.total} résultat{data.total > 1 ? 's' : ''} pour « {debouncedQuery} »
            </p>
          )}

          <div className="space-y-3">
            {data?.hits?.map((hit: ArticleHit) => (
              <article
                key={hit.article_id}
                className="border rounded-lg p-4 hover:border-primary/50 hover:bg-muted/20 transition-colors cursor-pointer"
                onClick={() => setSelectedArticle(hit)}
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={hit.source === 'code_travail_ci' ? 'default' : 'secondary'} className="text-xs">
                      {hit.source === 'code_travail_ci'
                        ? <><BookOpen className="h-3 w-3 mr-1" />Code du Travail</>
                        : <><Scale className="h-3 w-3 mr-1" />Convention</>}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{hit.article_numero}</span>
                    {hit.payroll_codes && hit.payroll_codes.length > 0 && (
                      <span className="text-xs text-primary flex items-center gap-1">
                        <Info className="h-3 w-3" />lié aux rubriques paie
                      </span>
                    )}
                  </div>
                </div>
                <h3 className="font-medium text-sm mb-1">{hit.titre_article}</h3>
                <p
                  className="text-xs text-muted-foreground line-clamp-3 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: highlight(hit) }}
                />
                {hit.livre && (
                  <p className="text-xs text-muted-foreground/60 mt-1 truncate">{hit.livre}{hit.titre ? ` › ${hit.titre}` : ''}</p>
                )}
              </article>
            ))}
          </div>

          {query.length > 0 && query.length < 2 && (
            <p className="text-center text-muted-foreground text-sm mt-10">Saisissez au moins 2 caractères…</p>
          )}
          {!query && (
            <div className="text-center text-muted-foreground mt-16">
              <Scale className="h-12 w-12 mx-auto mb-3 opacity-20" />
              <p className="text-sm">Recherchez un terme juridique, un article ou une rubrique de paie</p>
            </div>
          )}
        </div>
      </main>

      {/* Modale article */}
      {selectedArticle && (
        <ArticleModal article={selectedArticle} onClose={() => setSelectedArticle(null)} />
      )}
    </div>
  )
}
