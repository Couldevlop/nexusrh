import { useState, useCallback, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, BookOpen, Scale, ChevronDown, Info, X,
  Menu, FileText, Loader2, FolderOpen,
} from 'lucide-react'
import { ArticleModal } from '@/components/referentiels/ArticleModal'
import { api } from '@/lib/api'

interface ArticleHit {
  article_id: string; article_numero: string; source: string
  convention_slug?: string; livre?: string; titre?: string
  chapitre?: string; titre_article: string; texte: string
  payroll_codes?: string[]; score: number
  highlight?: { texte?: string[]; titre_article?: string[] }
}

interface Bucket   { key: string; doc_count: number }
interface TreeNode { key: string; doc_count: number; by_livre: { buckets: Bucket[] } }

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

const SRC = {
  code_travail_ci: {
    label: 'Code du Travail CI', short: 'Code du Travail',
    badge: 'bg-blue-50 text-blue-700 border-blue-200',
    icon: BookOpen, dot: 'bg-blue-500',
  },
  convention_collective: {
    label: 'Conventions Collectives', short: 'Convention',
    badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    icon: Scale, dot: 'bg-emerald-500',
  },
} as const

const SUGGESTIONS = ['SMIG', 'préavis', 'congés maternité', 'CNPS retraite', 'licenciement']

export default function ReferentielsPage() {
  const [query, setQuery]           = useState('')
  const [source, setSource]         = useState<'all' | 'code_travail_ci' | 'convention_collective'>('all')
  const [selectedArticle, setSelectedArticle] = useState<ArticleHit | null>(null)
  const [expanded, setExpanded]     = useState<Set<string>>(new Set(['code_travail_ci']))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dq = useDebounce(query, 350)

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [])

  const { data, isLoading } = useQuery<{ total: number; hits: ArticleHit[] }>({
    queryKey: ['referentiels', dq, source],
    queryFn: () => api.get('/referentiels/search', {
      params: { q: dq, ...(source !== 'all' && { source }), size: 20 },
    }).then((r: { data: { total: number; hits: ArticleHit[] } }) => r.data),
    enabled: dq.length >= 2,
    staleTime: 30_000,
  })

  const { data: tree } = useQuery<TreeNode[]>({
    queryKey: ['referentiels-tree'],
    queryFn: () => api.get('/referentiels/tree').then((r: { data: TreeNode[] }) => r.data),
    staleTime: 300_000,
  })

  const excerpt = useCallback((hit: ArticleHit) =>
    hit.highlight?.texte?.[0] ?? (hit.texte.slice(0, 220) + '…'), [])

  const toggleNode = (key: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })

  const pickLivre = (srcKey: string, livreKey: string) => {
    setSource(srcKey as 'code_travail_ci' | 'convention_collective')
    setQuery(livreKey)
    setDrawerOpen(false)
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const sommaire = (
    <div className="p-4 pt-5">
      <div className="flex items-center gap-2 mb-5 px-1">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center shadow-sm shrink-0">
          <Scale className="h-3.5 w-3.5 text-white" />
        </div>
        <span className="text-sm font-bold text-gray-800 tracking-tight">Sommaire</span>
      </div>

      {!tree && (
        <div className="space-y-2">
          {[80, 60].map(w => (
            <div key={w} className={`h-9 bg-gray-100 rounded-lg animate-pulse`} style={{ width: `${w}%` }} />
          ))}
        </div>
      )}

      {(tree ?? []).map(node => {
        const cfg = SRC[node.key as keyof typeof SRC]
        const isOpen = expanded.has(node.key)
        const Icon = cfg?.icon ?? FileText
        return (
          <div key={node.key} className="mb-1">
            <button
              onClick={() => toggleNode(node.key)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl hover:bg-gray-100 transition-colors group"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Icon className="h-3.5 w-3.5 text-gray-400 group-hover:text-blue-500 transition-colors shrink-0" />
                <span className="text-xs font-semibold text-gray-700 truncate">
                  {cfg?.label ?? node.key}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs text-gray-400 tabular-nums">{node.doc_count}</span>
                <motion.span animate={{ rotate: isOpen ? 180 : 0 }} transition={{ duration: 0.2 }}>
                  <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                </motion.span>
              </div>
            </button>

            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <div className="ml-5 border-l-2 border-gray-100 pl-3 py-1 space-y-0.5">
                    {node.by_livre?.buckets?.map(b => (
                      <button
                        key={b.key}
                        onClick={() => pickLivre(node.key, b.key)}
                        className="w-full flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-blue-50 group/item text-left transition-colors"
                      >
                        <span className="text-xs text-gray-500 group-hover/item:text-blue-600 transition-colors truncate pr-1">
                          {b.key}
                        </span>
                        <span className="text-xs text-gray-300 group-hover/item:text-blue-400 shrink-0 tabular-nums">
                          {b.doc_count}
                        </span>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden bg-gray-50/40">

      {/* Mobile overlay */}
      <AnimatePresence>
        {drawerOpen && (
          <motion.div
            key="overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            onClick={() => setDrawerOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar — drawer on mobile, fixed column on desktop */}
      <aside
        className={`
          fixed lg:static top-0 lg:top-auto inset-y-0 left-0 z-40
          w-64 bg-white border-r border-gray-100 overflow-y-auto shrink-0
          transition-transform duration-300 ease-in-out
          ${drawerOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}
          lg:translate-x-0 lg:shadow-none lg:h-full
        `}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 lg:hidden">
          <span className="text-sm font-bold text-gray-800">Sommaire</span>
          <button
            onClick={() => setDrawerOpen(false)}
            className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {sommaire}
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-6 lg:px-8">

          {/* Page header */}
          <div className="flex items-center gap-3 mb-6">
            <button
              onClick={() => setDrawerOpen(true)}
              className="lg:hidden p-2 rounded-xl hover:bg-white hover:shadow-sm text-gray-500 transition-all"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-gray-900">Référentiel Juridique CI</h1>
              <p className="text-xs text-gray-400 mt-0.5">
                Code du Travail ivoirien · Conventions Collectives · Recherche plein texte
              </p>
            </div>
          </div>

          {/* Search bar */}
          <div className="relative mb-4">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
              {isLoading
                ? <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
                : <Search className="h-4 w-4 text-gray-400" />
              }
            </div>
            <input
              ref={inputRef}
              type="text"
              className="w-full pl-10 pr-10 py-3 text-sm bg-white border border-gray-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all placeholder:text-gray-300"
              placeholder="Ex: indemnité maternité, préavis licenciement, SMIG…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              autoFocus
            />
            <div className="absolute inset-y-0 right-0 flex items-center pr-3.5 gap-1.5">
              {query
                ? (
                  <button onClick={() => setQuery('')} className="text-gray-400 hover:text-gray-600 transition-colors">
                    <X className="h-4 w-4" />
                  </button>
                )
                : (
                  <kbd className="hidden sm:flex items-center gap-0.5 text-xs text-gray-300 border border-gray-200 rounded px-1.5 py-0.5 font-sans">
                    ⌘K
                  </kbd>
                )
              }
            </div>
          </div>

          {/* Source filters */}
          <div className="flex gap-2 mb-6 flex-wrap">
            {(['all', 'code_travail_ci', 'convention_collective'] as const).map(k => (
              <button
                key={k}
                onClick={() => setSource(k)}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-full border transition-all ${
                  source === k
                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm shadow-blue-200'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300 hover:text-blue-600'
                }`}
              >
                {k === 'all' ? 'Tout' : k === 'code_travail_ci' ? 'Code du Travail' : 'Conventions'}
              </button>
            ))}
          </div>

          {/* Result count */}
          <AnimatePresence>
            {data && dq.length >= 2 && (
              <motion.p
                key="count"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="text-xs text-gray-400 mb-3"
              >
                <span className="font-semibold text-gray-600">{data.total}</span>{' '}
                résultat{data.total > 1 ? 's' : ''} pour{' '}
                <span className="text-blue-600">« {dq} »</span>
              </motion.p>
            )}
          </AnimatePresence>

          {/* Loading skeletons */}
          {isLoading && (
            <div className="space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="bg-white border border-gray-100 rounded-xl p-4 animate-pulse">
                  <div className="flex gap-3">
                    <div className="w-8 h-8 rounded-lg bg-gray-100 shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="flex gap-2">
                        <div className="h-5 w-24 bg-gray-100 rounded-full" />
                        <div className="h-5 w-14 bg-gray-100 rounded" />
                      </div>
                      <div className="h-4 w-3/4 bg-gray-100 rounded" />
                      <div className="h-3 w-full bg-gray-100 rounded" />
                      <div className="h-3 w-5/6 bg-gray-100 rounded" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Article results */}
          {!isLoading && data?.hits && data.hits.length > 0 && (
            <div className="space-y-3">
              {data.hits.map((hit, i) => {
                const cfg = SRC[hit.source as keyof typeof SRC]
                const Icon = cfg?.icon ?? FileText
                return (
                  <motion.article
                    key={hit.article_id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.04, duration: 0.22 }}
                    onClick={() => setSelectedArticle(hit)}
                    className="group bg-white border border-gray-100 rounded-xl p-4 hover:border-blue-200 hover:shadow-md hover:shadow-blue-50/60 cursor-pointer transition-all duration-200"
                  >
                    <div className="flex items-start gap-3">
                      <div className={`mt-0.5 shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                        hit.source === 'code_travail_ci'
                          ? 'bg-blue-50 text-blue-500 group-hover:bg-blue-100'
                          : 'bg-emerald-50 text-emerald-500 group-hover:bg-emerald-100'
                      }`}>
                        <Icon className="h-4 w-4" />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                          <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium border ${cfg?.badge ?? 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                            {cfg?.short ?? hit.source}
                          </span>
                          <span className="text-xs text-gray-400 font-mono">{hit.article_numero}</span>
                          {hit.payroll_codes && hit.payroll_codes.length > 0 && (
                            <span className="inline-flex items-center gap-0.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                              <Info className="h-3 w-3" />lié paie
                            </span>
                          )}
                        </div>

                        <h3 className="text-sm font-semibold text-gray-800 mb-1.5 group-hover:text-blue-700 transition-colors leading-snug">
                          {hit.titre_article}
                        </h3>

                        <p
                          className="text-xs text-gray-500 line-clamp-2 leading-relaxed"
                          dangerouslySetInnerHTML={{ __html: excerpt(hit) }}
                        />

                        {hit.livre && (
                          <p className="flex items-center gap-1 text-xs text-gray-300 mt-2 truncate">
                            <FolderOpen className="h-3 w-3 shrink-0" />
                            {[hit.livre, hit.titre].filter(Boolean).join(' › ')}
                          </p>
                        )}
                      </div>
                    </div>
                  </motion.article>
                )
              })}
            </div>
          )}

          {/* No results */}
          {!isLoading && data?.hits?.length === 0 && dq.length >= 2 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center py-16"
            >
              <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-4">
                <Search className="h-7 w-7 text-gray-300" />
              </div>
              <p className="text-sm font-semibold text-gray-700 mb-1">Aucun résultat pour « {dq} »</p>
              <p className="text-xs text-gray-400">Essayez un autre terme ou modifiez le filtre de source</p>
            </motion.div>
          )}

          {/* Empty / welcome state */}
          {!query && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center py-14"
            >
              <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center mx-auto mb-5">
                <Scale className="h-9 w-9 text-blue-400" />
              </div>
              <h2 className="text-base font-bold text-gray-700 mb-2">
                Référentiel Juridique Ivoirien
              </h2>
              <p className="text-sm text-gray-400 mb-6 max-w-sm mx-auto leading-relaxed">
                Recherchez un terme, un article ou une rubrique de paie dans le Code du Travail CI et les conventions collectives.
              </p>
              <div className="flex items-center justify-center gap-5 text-xs text-gray-400 mb-6">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />
                  Code du Travail CI
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
                  Conventions Collectives
                </span>
              </div>
              <div className="flex flex-wrap gap-2 justify-center">
                {SUGGESTIONS.map(term => (
                  <button
                    key={term}
                    onClick={() => { setQuery(term); inputRef.current?.focus() }}
                    className="text-xs px-3.5 py-1.5 bg-white border border-gray-200 rounded-full text-gray-600 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50 transition-all shadow-sm"
                  >
                    {term}
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </div>
      </main>

      {selectedArticle && (
        <ArticleModal article={selectedArticle} onClose={() => setSelectedArticle(null)} />
      )}
    </div>
  )
}
