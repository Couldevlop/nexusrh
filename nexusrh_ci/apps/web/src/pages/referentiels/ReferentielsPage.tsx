import { useState, useCallback, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { useSearchParams } from 'react-router-dom'
import { useTranslation, Trans } from 'react-i18next'
import { useAuthStore } from '@/stores/authStore'
import {
  Search, BookOpen, Scale, ChevronDown, ChevronRight,
  Info, X, Menu, FileText, Loader2, FolderOpen,
} from 'lucide-react'
import { ArticleModal } from '@/components/referentiels/ArticleModal'
import { api } from '@/lib/api'

/* ─── Types ─────────────────────────────────────────────────────────────── */
interface ArticleHit {
  article_id: string; article_numero: string; source: string
  convention_slug?: string; livre?: string; titre?: string
  chapitre?: string; titre_article: string; texte: string
  payroll_codes?: string[]; score: number
  highlight?: { texte?: string[]; titre_article?: string[] }
}
interface Bucket   { key: string; doc_count: number }
interface TreeNode { key: string; doc_count: number; by_livre: { buckets: Bucket[] } }

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function useDebounce<T>(value: T, ms: number): T {
  const [d, setD] = useState(value)
  useEffect(() => { const t = setTimeout(() => setD(value), ms); return () => clearTimeout(t) }, [value, ms])
  return d
}

const SRC = {
  code_travail_ci:      { badge: 'bg-blue-50 text-blue-700 border-blue-200', Icon: BookOpen },
  convention_collective:{ badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: Scale },
} as const

// Les libellés des chips sont traduits, mais le terme de recherche reste en
// français car l'index plein-texte (Code du Travail CI) est en français.
const CHIPS = [
  { key: 'smig',             query: 'SMIG' },
  { key: 'preavis',          query: 'préavis' },
  { key: 'congesMaternite',  query: 'congés maternité' },
  { key: 'cnpsRetraite',     query: 'CNPS retraite' },
  { key: 'licenciement',     query: 'licenciement' },
] as const

/* ─── LivreNode — composant isolé pour respecter les règles des hooks ─── */
function LivreNode({ srcKey, livre, onOpen }: {
  srcKey: string
  livre: Bucket
  onOpen: (a: ArticleHit) => void
}) {
  const { t } = useTranslation('referentiels')
  const [open, setOpen] = useState(false)

  const { data, isFetching } = useQuery<{ total: number; hits: ArticleHit[] }>({
    queryKey: ['ref-livre', srcKey, livre.key],
    queryFn: () => api.get('/referentiels/search', {
      params: { q: '*', source: srcKey, livre: livre.key, size: 100 },
    }).then((r: { data: { total: number; hits: ArticleHit[] } }) => r.data),
    enabled: open,
    staleTime: 600_000,
  })

  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-blue-50 group/l transition-colors"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.18 }}>
            <ChevronRight className="h-3 w-3 text-gray-400 shrink-0" />
          </motion.span>
          <span className="text-xs text-gray-600 group-hover/l:text-blue-600 transition-colors truncate">
            {livre.key}
          </span>
        </div>
        <span className="text-xs text-gray-300 tabular-nums shrink-0 ml-1">{livre.doc_count}</span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="ml-5 border-l border-gray-100 pl-2 py-1 space-y-0.5">
              {isFetching && !data && (
                <div className="space-y-1 py-1">
                  {[1,2,3].map(i => <div key={i} className="h-6 bg-gray-100 rounded animate-pulse" />)}
                </div>
              )}
              {data?.hits.map(art => (
                <button
                  key={art.article_id}
                  onClick={() => onOpen(art)}
                  className="w-full text-left py-1.5 px-2 rounded hover:bg-indigo-50 group/a transition-colors"
                >
                  <span className="block text-xs font-mono text-gray-400 group-hover/a:text-indigo-500 leading-none mb-0.5">
                    {art.article_numero}
                  </span>
                  <span className="block text-xs text-gray-600 group-hover/a:text-indigo-700 leading-snug line-clamp-2">
                    {art.titre_article}
                  </span>
                </button>
              ))}
              {data?.hits.length === 0 && (
                <p className="text-xs text-gray-300 py-1 px-2">{t('sidebar.noArticle')}</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const COUNTRY_CODES = ['CIV', 'BEN', 'TGO', 'BFA', 'SEN', 'MLI', 'NER', 'TCD', 'NGA'] as const

interface MyCountry {
  countryCode: string | null
  hasSubsidiaries: boolean
  scope: 'platform' | 'single_country' | 'multi_country' | 'unknown' | 'fallback'
  defaultCountryCode?: string
}

/* ─── Page principale ────────────────────────────────────────────────────── */
export default function ReferentielsPage() {
  const { t } = useTranslation('referentiels')
  // Libellé pays : clé i18n si connue, sinon le code brut (données API).
  const countryLabel = (code: string) =>
    (COUNTRY_CODES as readonly string[]).includes(code) ? t(`countries.${code}`) : code
  const [query, setQuery]   = useState('')
  const [source, setSource] = useState<'all' | 'code_travail_ci' | 'convention_collective'>('all')
  const [countryFilter, setCountryFilter] = useState<string | null>(null)
  const [modal, setModal]   = useState<ArticleHit | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['code_travail_ci']))
  const [drawer, setDrawer] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dq = useDebounce(query, 200)

  // Pays applicable au user connecté (silencieux si endpoint indisponible)
  const { data: myCountry } = useQuery<MyCountry>({
    queryKey: ['referentiels-my-country'],
    queryFn: () => api.get('/referentiels/my-country').then(r => r.data),
    staleTime: 5 * 60_000,
    retry: false,
  })

  // Initialise le filtre pays au pays applicable du user
  useEffect(() => {
    if (myCountry && countryFilter === null) {
      setCountryFilter(myCountry.countryCode)
    }
  }, [myCountry, countryFilter])

  // Source de vérité : flag du tenant (cohérent avec Settings + Sourcing).
  // Fallback sur l'endpoint /my-country qui repose sur la même donnée serveur.
  const tenantConfig = useAuthStore((s) => s.tenantConfig)
  const isMultiCountry = (tenantConfig?.hasSubsidiaries ?? myCountry?.hasSubsidiaries) === true

  // Synchronisation avec le query param ?q=... : permet à la page d'afficher
  // un article spécifique quand on arrive depuis ArticleModal ou un lien externe.
  // Si on est DÉJÀ sur la page, le navigate met juste à jour searchParams →
  // ce useEffect déclenche setQuery → re-search avec le numéro article.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const q = searchParams.get('q')
    if (q && q !== query) {
      setQuery(q)
      inputRef.current?.focus()
    }
    // Pas de dep sur `query` pour ne pas relancer en boucle quand l'utilisateur
    // édite ensuite manuellement le champ.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])
  // Quand l'utilisateur édite manuellement le champ après une navigation,
  // on retire le query param pour ne pas re-déclencher au prochain render.
  useEffect(() => {
    const current = searchParams.get('q')
    if (current && current !== query) {
      const next = new URLSearchParams(searchParams)
      next.delete('q')
      setSearchParams(next, { replace: true })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  /* Ctrl/Cmd+K → focus */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); inputRef.current?.focus() }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [])

  /* Recherche principale */
  const { data, isLoading, isError } = useQuery<{ total: number; hits: ArticleHit[] }>({
    queryKey: ['referentiels', dq, source, countryFilter],
    queryFn: () => api.get('/referentiels/search', {
      params: {
        q: dq,
        ...(source !== 'all' && { source }),
        ...(countryFilter && { countryCode: countryFilter }),
        size: 100,
      },
    }).then((r: { data: { total: number; hits: ArticleHit[] } }) => r.data),
    enabled: dq.length >= 2,
    staleTime: 30_000,
  })

  /* Arborescence */
  const { data: tree } = useQuery<TreeNode[]>({
    queryKey: ['referentiels-tree'],
    queryFn: () => api.get('/referentiels/tree').then((r: { data: TreeNode[] }) => r.data),
    staleTime: 600_000,
  })

  // OWASP A03 — sanitize l'extrait Elasticsearch avant injection HTML.
  // Le highlight ES utilise par défaut <em>...</em> pour marquer les termes
  // matchés. On échappe TOUT le HTML, puis on restaure UNIQUEMENT <em>/</em>
  // (whitelist stricte). Bloque l'injection d'<img onerror>, <script>, etc.
  // qui serait possible si un article du référentiel contenait du HTML brut.
  const sanitizeExcerpt = (raw: string): string => {
    const escaped = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
    // Restaurer les balises <em> de highlight ES (échappées en &lt;em&gt;)
    return escaped
      .replace(/&lt;em&gt;/g, '<em>')
      .replace(/&lt;\/em&gt;/g, '</em>')
  }

  const excerpt = useCallback((hit: ArticleHit) =>
    sanitizeExcerpt(hit.highlight?.texte?.[0] ?? hit.texte.slice(0, 200) + '…'), [])

  const toggle = (key: string) =>
    setExpanded(p => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n })

  /* ── Sidebar content ── */
  const sidebar = (
    <div className="p-3 pt-4">
      <div className="flex items-center gap-2 mb-4 px-1">
        <div className="w-6 h-6 rounded-md bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center shrink-0">
          <Scale className="h-3 w-3 text-white" />
        </div>
        <span className="text-xs font-bold text-gray-700 uppercase tracking-widest">{t('sidebar.summary')}</span>
      </div>

      {!tree && <div className="space-y-2">{[1,2].map(i=><div key={i} className="h-8 bg-gray-100 rounded-lg animate-pulse"/>)}</div>}

      {(tree ?? []).map(node => {
        const cfg = SRC[node.key as keyof typeof SRC]
        const isOpen = expanded.has(node.key)
        const Icon = cfg?.Icon ?? FileText
        return (
          <div key={node.key} className="mb-1">
            {/* Source header */}
            <button
              onClick={() => toggle(node.key)}
              className="w-full flex items-center justify-between gap-1.5 px-2.5 py-2 rounded-xl hover:bg-gray-100 transition-colors group"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Icon className="h-3.5 w-3.5 text-gray-400 group-hover:text-blue-500 shrink-0 transition-colors" />
                <span className="text-xs font-semibold text-gray-700 truncate">{cfg ? t(`sources.${node.key}`) : node.key}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-xs text-gray-400 tabular-nums">{node.doc_count}</span>
                <motion.span animate={{ rotate: isOpen ? 180 : 0 }} transition={{ duration: 0.2 }}>
                  <ChevronDown className="h-3 w-3 text-gray-400" />
                </motion.span>
              </div>
            </button>

            {/* Livres accordion */}
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <div className="ml-4 border-l-2 border-gray-100 pl-2.5 py-1 space-y-0.5">
                    {node.by_livre?.buckets?.map(livre => (
                      <LivreNode
                        key={livre.key}
                        srcKey={node.key}
                        livre={livre}
                        onOpen={art => { setModal(art); setDrawer(false) }}
                      />
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
    <div className="flex h-[calc(100vh-64px)] overflow-hidden bg-slate-50">

      {/* Mobile overlay */}
      <AnimatePresence>
        {drawer && (
          <motion.div key="ov" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            onClick={() => setDrawer(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className={`
        fixed lg:static inset-y-0 left-0 z-40 w-64 bg-white border-r border-gray-100 overflow-y-auto shrink-0
        transition-transform duration-250 ease-in-out
        ${drawer ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}
        lg:translate-x-0 lg:shadow-none lg:h-full
      `}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 lg:hidden">
          <span className="text-xs font-bold text-gray-700 uppercase tracking-widest">{t('sidebar.summary')}</span>
          <button onClick={() => setDrawer(false)} className="p-1 rounded-lg text-gray-400 hover:bg-gray-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        {sidebar}
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-6 lg:px-6">

          {/* Header */}
          <div className="flex items-center gap-3 mb-5">
            <button onClick={() => setDrawer(true)} className="lg:hidden p-2 rounded-xl hover:bg-white text-gray-500 hover:shadow-sm transition-all">
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-bold text-gray-900">
                {countryFilter
                  ? t('header.titleWithCountry', { country: countryLabel(countryFilter) })
                  : t('header.title')}
              </h1>
              <p className="text-xs text-gray-400">{t('header.subtitle')}</p>
            </div>
          </div>

          {/* Bandeau filiale (uniquement si tenant multi-pays) */}
          {isMultiCountry && (
            <div className="mb-4 rounded-xl border border-purple-200 bg-purple-50/50 px-3 py-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-purple-700">
                {t('subsidiary.applicableLabel')}
              </span>
              <select
                value={countryFilter ?? ''}
                onChange={e => setCountryFilter(e.target.value || null)}
                className="rounded-md border border-purple-200 bg-white px-2 py-1 text-xs font-medium text-purple-800 focus:outline-none focus:ring-2 focus:ring-purple-400"
              >
                <option value="">{t('subsidiary.allCountries')}</option>
                {COUNTRY_CODES.map(code => (
                  <option key={code} value={code}>{countryLabel(code)} ({code})</option>
                ))}
              </select>
              {myCountry?.countryCode && countryFilter !== myCountry.countryCode && (
                <button
                  onClick={() => setCountryFilter(myCountry.countryCode)}
                  className="text-[11px] text-purple-700 underline hover:text-purple-900"
                >
                  {t('subsidiary.backToMine', { country: myCountry.countryCode })}
                </button>
              )}
            </div>
          )}

          {/* Search */}
          <div className="relative mb-3">
            <div className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center">
              {isLoading
                ? <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
                : <Search className="h-4 w-4 text-gray-400" />}
            </div>
            <input
              ref={inputRef} type="text" autoFocus
              className="w-full pl-10 pr-10 py-2.5 text-sm bg-white border border-gray-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all placeholder:text-gray-300"
              placeholder={t('search.placeholder')}
              value={query} onChange={e => setQuery(e.target.value)}
            />
            {query
              ? <button onClick={() => setQuery('')} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
              : <kbd className="absolute right-3.5 top-1/2 -translate-y-1/2 hidden sm:block text-xs text-gray-300 border border-gray-200 rounded px-1.5 py-0.5">⌘K</kbd>
            }
          </div>

          {/* Source tabs */}
          <div className="flex gap-1.5 mb-5">
            {(['all','code_travail_ci','convention_collective'] as const).map(k => (
              <button key={k} onClick={() => setSource(k)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-all ${
                  source === k
                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                    : 'bg-white text-gray-500 border-gray-200 hover:border-blue-300 hover:text-blue-600'
                }`}>
                {k === 'all' ? t('tabs.all') : k === 'code_travail_ci' ? t('tabs.codeTravail') : t('tabs.conventions')}
              </button>
            ))}
          </div>

          {/* Result count */}
          <AnimatePresence>
            {data && dq.length >= 2 && (
              <motion.p key="c" initial={{ opacity: 0, y:-4 }} animate={{ opacity: 1, y:0 }} exit={{ opacity: 0 }}
                className="text-xs text-gray-400 mb-3">
                <Trans
                  i18nKey="search.resultCount"
                  ns="referentiels"
                  count={data.total}
                  values={{ count: data.total, query: dq }}
                  components={[
                    <span className="font-semibold text-gray-600" />,
                    <span className="text-blue-600" />,
                  ]}
                />
              </motion.p>
            )}
          </AnimatePresence>

          {/* Erreur API */}
          {isError && dq.length >= 2 && (
            <div className="text-center py-10 text-sm text-red-400">
              {t('search.error')}
            </div>
          )}

          {/* Skeletons */}
          {isLoading && (
            <div className="space-y-2.5">
              {[1,2,3].map(i => (
                <div key={i} className="bg-white border border-gray-100 rounded-xl p-4 animate-pulse flex gap-3">
                  <div className="w-8 h-8 bg-gray-100 rounded-lg shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-gray-100 rounded w-2/3" />
                    <div className="h-3 bg-gray-100 rounded w-full" />
                    <div className="h-3 bg-gray-100 rounded w-4/5" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Results */}
          {!isLoading && data?.hits && data.hits.length > 0 && (
            <div className={`space-y-2.5 ${data.hits.length > 5 ? 'max-h-[62vh] overflow-y-auto pr-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-200 [&::-webkit-scrollbar-track]:bg-transparent' : ''}`}>
              {data.hits.map((hit, i) => {
                const cfg = SRC[hit.source as keyof typeof SRC]
                const Icon = cfg?.Icon ?? FileText
                return (
                  <motion.article key={hit.article_id}
                    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.035, duration: 0.2 }}
                    onClick={() => setModal(hit)}
                    className="group bg-white border border-gray-100 rounded-xl p-4 hover:border-blue-200 hover:shadow-md hover:shadow-blue-50/50 cursor-pointer transition-all"
                  >
                    <div className="flex items-start gap-3">
                      <div className={`mt-0.5 shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${
                        hit.source === 'code_travail_ci' ? 'bg-blue-50 text-blue-500' : 'bg-emerald-50 text-emerald-500'}`}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${cfg?.badge ?? 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                            {cfg ? t(`sources.${hit.source}_short`) : hit.source}
                          </span>
                          <span className="text-xs text-gray-400 font-mono">{hit.article_numero}</span>
                          {hit.payroll_codes && hit.payroll_codes.length > 0 && (
                            <span className="text-xs text-amber-600 bg-amber-50 border border-amber-100 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                              <Info className="h-3 w-3" />{t('search.payrollBadge')}
                            </span>
                          )}
                        </div>
                        <h3 className="text-sm font-semibold text-gray-800 mb-1.5 group-hover:text-blue-700 transition-colors leading-snug">
                          {hit.titre_article}
                        </h3>
                        <p className="text-xs text-gray-500 line-clamp-2 leading-relaxed"
                          dangerouslySetInnerHTML={{ __html: excerpt(hit) }} />
                        {hit.livre && (
                          <p className="flex items-center gap-1 text-xs text-gray-300 mt-1.5 truncate">
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
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="text-center py-14">
              <div className="w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-3">
                <Search className="h-6 w-6 text-gray-300" />
              </div>
              <p className="text-sm font-medium text-gray-700 mb-1">{t('search.noResultTitle', { query: dq })}</p>
              <p className="text-xs text-gray-400">{t('search.noResultHint')}</p>
            </motion.div>
          )}

          {/* Welcome */}
          {!query && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="text-center py-12">
              <div className="w-16 h-16 rounded-3xl bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center mx-auto mb-4">
                <Scale className="h-7 w-7 text-blue-400" />
              </div>
              <h2 className="text-sm font-bold text-gray-700 mb-1.5">{t('welcome.title')}</h2>
              <p className="text-xs text-gray-400 mb-5 max-w-xs mx-auto leading-relaxed">
                {t('welcome.subtitle')}
              </p>
              <div className="flex flex-wrap gap-2 justify-center">
                {CHIPS.map(chip => (
                  <button key={chip.key} onClick={() => { setQuery(chip.query); inputRef.current?.focus() }}
                    className="text-xs px-3 py-1.5 bg-white border border-gray-200 rounded-full text-gray-600 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50 transition-all shadow-sm">
                    {t(`chips.${chip.key}`)}
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </div>
      </main>

      {modal && <ArticleModal article={modal} onClose={() => setModal(null)} />}
    </div>
  )
}
