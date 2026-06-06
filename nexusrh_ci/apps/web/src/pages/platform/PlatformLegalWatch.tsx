/**
 * Page Super Admin — Veille réglementaire
 *
 * Affiche les propositions de mise à jour d'articles juridiques détectées
 * par l'IA (manuellement collées ou via worker scraper). Permet au super_admin
 * de revoir le diff, approuver ou rejeter chaque proposition.
 *
 * UX inspirée Greenhouse / Lever (workflow review) + GitHub PR (diff viewer).
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import {
  Scale, Sparkles, CheckCircle, XCircle, AlertCircle, Clock,
  Filter, FileText, ExternalLink, Loader2, Wand2, Send,
  ChevronRight, Eye, Plus,
} from 'lucide-react'

type Status = 'pending' | 'approved' | 'rejected' | 'superseded' | 'all'
type Risk = 'low' | 'medium' | 'high'

interface Proposal {
  id: string
  article_id: string | null
  country_code: string
  source: string
  source_url: string | null
  source_type: string
  proposed_at: string
  proposed_by: string | null
  diff_summary: string | null
  ai_confidence: number | null
  ai_model: string | null
  status: Status
  reviewed_at: string | null
  reviewed_by: string | null
  current_title: string | null
  article_numero: string | null
}

interface ProposalDetail extends Proposal {
  current_text: string | null
  proposed_text: string
  ai_reasoning: string | null
  review_notes: string | null
}

// Libellés traduits via i18n (legalWatch.status.*) — ici uniquement style + icône.
const STATUS_CONFIG: Record<Status, { color: string; icon: typeof Clock }> = {
  pending:    { color: 'bg-amber-100 text-amber-800 border-amber-200',    icon: Clock },
  approved:   { color: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: CheckCircle },
  rejected:   { color: 'bg-rose-100 text-rose-800 border-rose-200',       icon: XCircle },
  superseded: { color: 'bg-slate-100 text-slate-700 border-slate-200',    icon: AlertCircle },
  all:        { color: 'bg-slate-100 text-slate-700 border-slate-200',    icon: Filter },
}

function confidenceColor(c: number): string {
  if (c >= 80) return 'text-emerald-700 bg-emerald-100'
  if (c >= 50) return 'text-amber-700 bg-amber-100'
  return 'text-rose-700 bg-rose-100'
}

export default function PlatformLegalWatch() {
  const { t } = useTranslation('platform')
  const qc = useQueryClient()
  const [status, setStatus] = useState<Status>('pending')
  const [selected, setSelected] = useState<string | null>(null)
  const [showAnalyzer, setShowAnalyzer] = useState(false)

  const { data: stats } = useQuery<{ data: { pending: number; approved: number; rejected: number; superseded: number } }>({
    queryKey: ['legal-watch-stats'],
    queryFn: () => api.get('/platform/legal-watch/stats').then(r => r.data),
    staleTime: 30_000,
  })

  const { data: list, isLoading } = useQuery<{ data: Proposal[]; total: number }>({
    queryKey: ['legal-watch-list', status],
    queryFn: () => api.get('/platform/legal-watch/proposals', { params: { status } }).then(r => r.data),
  })

  const onAnalyzed = () => {
    setShowAnalyzer(false)
    qc.invalidateQueries({ queryKey: ['legal-watch-list'] })
    qc.invalidateQueries({ queryKey: ['legal-watch-stats'] })
    qc.invalidateQueries({ queryKey: ['platform-legal-watch-stats'] })
  }
  const onReviewed = () => {
    setSelected(null)
    qc.invalidateQueries({ queryKey: ['legal-watch-list'] })
    qc.invalidateQueries({ queryKey: ['legal-watch-stats'] })
    qc.invalidateQueries({ queryKey: ['platform-legal-watch-stats'] })
  }

  const proposals = list?.data ?? []
  const counts = stats?.data ?? { pending: 0, approved: 0, rejected: 0, superseded: 0 }

  return (
    <div className="p-6 space-y-5">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl border border-indigo-200/60 bg-gradient-to-br from-indigo-50 via-blue-50 to-cyan-50 p-6 shadow-sm">
        <div className="absolute -right-12 -top-12 h-48 w-48 rounded-full bg-blue-300/30 blur-3xl" />
        <div className="relative flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg shadow-blue-500/30">
              <Scale className="h-7 w-7 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900">{t('legalWatch.title')}</h1>
              <p className="mt-1 text-sm text-slate-600 max-w-2xl">
                {t('legalWatch.subtitle')}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowAnalyzer(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all">
            <Plus className="h-4 w-4" /> {t('legalWatch.newProposal')}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(['pending', 'approved', 'rejected', 'superseded'] as const).map(s => {
          const cfg = STATUS_CONFIG[s]
          const Icon = cfg.icon
          return (
            <button key={s} onClick={() => setStatus(s)}
              className={`rounded-xl border p-4 text-left transition-all ${
                status === s
                  ? 'border-indigo-400 bg-indigo-50/50 shadow-md ring-2 ring-indigo-100'
                  : 'border-border bg-card hover:border-indigo-200 hover:shadow-sm'
              }`}>
              <div className="flex items-center justify-between mb-2">
                <Icon className="h-5 w-5 text-slate-400" />
                <span className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${cfg.color}`}>
                  {t(`legalWatch.status.${s}`)}
                </span>
              </div>
              <div className="text-2xl font-bold text-slate-900">{counts[s] ?? 0}</div>
            </button>
          )
        })}
      </div>

      {/* Filtre rapide "Toutes" */}
      <div className="flex justify-end">
        <button onClick={() => setStatus('all')}
          className={`inline-flex items-center gap-1 text-xs ${status === 'all' ? 'text-indigo-700 font-semibold' : 'text-slate-500 hover:text-slate-700'}`}>
          <Filter className="h-3.5 w-3.5" /> {t('legalWatch.viewAll')}
        </button>
      </div>

      {/* Liste */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center p-10">
            <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
          </div>
        ) : proposals.length === 0 ? (
          <div className="p-12 text-center">
            <Scale className="mx-auto h-12 w-12 text-slate-300 mb-3" />
            <p className="text-base font-semibold text-slate-700">
              {t('legalWatch.emptyTitle', { status: t(`legalWatch.status.${status}`).toLowerCase() })}
            </p>
            <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
              {t('legalWatch.emptyHint')}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {proposals.map(p => (
              <ProposalRow key={p.id} proposal={p} onOpen={() => setSelected(p.id)} />
            ))}
          </ul>
        )}
      </div>

      {/* Modales */}
      {selected && (
        <ProposalReviewModal id={selected} onClose={() => setSelected(null)} onReviewed={onReviewed} />
      )}
      {showAnalyzer && (
        <ProposalAnalyzerModal onClose={() => setShowAnalyzer(false)} onAnalyzed={onAnalyzed} />
      )}
    </div>
  )
}

// ─── Une ligne de la liste ──────────────────────────────────────────────────
function ProposalRow({ proposal, onOpen }: { proposal: Proposal; onOpen: () => void }) {
  const { t, i18n } = useTranslation('platform')
  const cfg = STATUS_CONFIG[proposal.status]
  const StatusIcon = cfg.icon
  const conf = proposal.ai_confidence ?? 0
  return (
    <li onClick={onOpen}
      className="group flex items-start gap-4 p-4 hover:bg-indigo-50/30 cursor-pointer transition-colors">
      <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ${
        proposal.status === 'pending' ? 'bg-amber-100' :
        proposal.status === 'approved' ? 'bg-emerald-100' :
        proposal.status === 'rejected' ? 'bg-rose-100' : 'bg-slate-100'
      }`}>
        <StatusIcon className={`h-5 w-5 ${
          proposal.status === 'pending' ? 'text-amber-600' :
          proposal.status === 'approved' ? 'text-emerald-600' :
          proposal.status === 'rejected' ? 'text-rose-600' : 'text-slate-600'
        }`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-slate-900 truncate group-hover:text-indigo-700">
            {proposal.current_title ?? t('legalWatch.row.newArticle')}
          </h3>
          {proposal.article_numero && (
            <span className="text-xs text-slate-400 font-mono">{proposal.article_numero}</span>
          )}
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${confidenceColor(conf)}`}>
            <Sparkles className="inline h-3 w-3 mr-0.5" />{t('legalWatch.row.aiConfidence', { confidence: conf })}
          </span>
        </div>
        <p className="text-sm text-slate-600 line-clamp-2 mt-1">
          {proposal.diff_summary ?? t('legalWatch.row.noSummary')}
        </p>
        <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <FileText className="h-3 w-3" /> {proposal.source}
          </span>
          <span>·</span>
          <span>{new Date(proposal.proposed_at).toLocaleDateString(i18n.language, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          <span>·</span>
          <span className="uppercase tracking-wide">{proposal.country_code}</span>
          {proposal.source_url && (
            <>
              <span>·</span>
              <a href={proposal.source_url} target="_blank" rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="inline-flex items-center gap-0.5 text-indigo-600 hover:underline">
                <ExternalLink className="h-3 w-3" /> {t('legalWatch.row.source')}
              </a>
            </>
          )}
        </div>
      </div>
      <ChevronRight className="h-5 w-5 text-slate-300 group-hover:text-indigo-500 mt-1" />
    </li>
  )
}

// ─── Modale d'analyse (nouvelle proposition) ────────────────────────────────
function ProposalAnalyzerModal({ onClose, onAnalyzed }: {
  onClose: () => void; onAnalyzed: () => void
}) {
  const { t } = useTranslation('platform')
  const [form, setForm] = useState({
    article_id:    '',
    country_code:  'CIV',
    source:        'code_travail',
    source_url:    '',
    proposed_text: '',
    context:       '',
  })
  const [error, setError] = useState<string | null>(null)
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([])

  const analyze = useMutation<{ data: { id: string; diff: { confidence: number; summary: string; risk_level: Risk } } }, unknown, typeof form>({
    mutationFn: (body) => {
      const payload: Record<string, unknown> = {
        country_code:  body.country_code.toUpperCase(),
        source:        body.source,
        proposed_text: body.proposed_text,
        source_type:   'manual',
      }
      if (body.article_id.trim()) payload.article_id = body.article_id.trim()
      if (body.source_url.trim()) payload.source_url = body.source_url.trim()
      if (body.context.trim())    payload.context = body.context.trim()
      return api.post('/platform/legal-watch/analyze', payload).then(r => r.data)
    },
    onSuccess: () => { onAnalyzed() },
    onError: (e) => {
      const resp = (e as { response?: { data?: { error?: string; issues?: { field: string; message: string }[] } } }).response?.data
      setError(resp?.error ?? t('legalWatch.analyzer.error'))
      setIssues(resp?.issues ?? [])
    },
  })

  const canSubmit = form.proposed_text.trim().length >= 10 && form.source.trim().length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-y-auto"
      onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-card shadow-2xl my-auto"
        onClick={e => e.stopPropagation()}>
        <div className="bg-gradient-to-r from-indigo-600 to-blue-600 text-white px-5 py-4 rounded-t-2xl">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs uppercase tracking-wider opacity-80">{t('legalWatch.analyzer.eyebrow')}</p>
              <h2 className="text-lg font-bold mt-0.5">{t('legalWatch.analyzer.title')}</h2>
              <p className="text-xs opacity-90 mt-1">
                {t('legalWatch.analyzer.subtitle')}
              </p>
            </div>
            <button onClick={onClose} className="rounded-full p-1 hover:bg-white/20" aria-label={t('common.close')}>
              <XCircle className="h-5 w-5 text-white" />
            </button>
          </div>
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-700">{t('legalWatch.analyzer.articleId')}</label>
              <input value={form.article_id} onChange={e => setForm(p => ({ ...p, article_id: e.target.value }))}
                placeholder={t('legalWatch.analyzer.articleIdPlaceholder')}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
              <p className="text-[10px] text-slate-500 mt-0.5">{t('legalWatch.analyzer.articleIdHint')}</p>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-700">{t('legalWatch.analyzer.country')}</label>
              <input value={form.country_code} onChange={e => setForm(p => ({ ...p, country_code: e.target.value.toUpperCase().slice(0, 3) }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono uppercase"
                maxLength={3} />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-700">{t('legalWatch.analyzer.source')}</label>
              <select value={form.source} onChange={e => setForm(p => ({ ...p, source: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
                <option value="code_travail">{t('legalWatch.analyzer.sourceOptions.code_travail')}</option>
                <option value="convention_collective">{t('legalWatch.analyzer.sourceOptions.convention_collective')}</option>
                <option value="jo">{t('legalWatch.analyzer.sourceOptions.jo')}</option>
                <option value="dgi">{t('legalWatch.analyzer.sourceOptions.dgi')}</option>
                <option value="cnps">{t('legalWatch.analyzer.sourceOptions.cnps')}</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-700">{t('legalWatch.analyzer.sourceUrl')}</label>
            <input value={form.source_url} onChange={e => setForm(p => ({ ...p, source_url: e.target.value }))}
              placeholder={t('legalWatch.analyzer.sourceUrlPlaceholder')}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-700">
              {t('legalWatch.analyzer.proposedText')} <span className="text-slate-400 font-normal">{t('legalWatch.analyzer.proposedTextCount', { count: form.proposed_text.length })}</span>
            </label>
            <textarea value={form.proposed_text} onChange={e => setForm(p => ({ ...p, proposed_text: e.target.value }))}
              rows={10} maxLength={30_000}
              placeholder={t('legalWatch.analyzer.proposedTextPlaceholder')}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono leading-relaxed resize-none" />
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-700">{t('legalWatch.analyzer.context')}</label>
            <input value={form.context} onChange={e => setForm(p => ({ ...p, context: e.target.value }))}
              placeholder={t('legalWatch.analyzer.contextPlaceholder')}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <p className="font-medium">{error}</p>
              {issues.length > 0 && (
                <ul className="mt-1 text-xs space-y-0.5">
                  {issues.map((i, k) => <li key={k}>• <strong>{i.field}</strong> : {i.message}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border px-5 py-3 flex items-center justify-end gap-2 bg-slate-50 rounded-b-2xl">
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700">{t('legalWatch.analyzer.cancel')}</button>
          <button onClick={() => { setError(null); setIssues([]); analyze.mutate(form) }}
            disabled={!canSubmit || analyze.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-indigo-600 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md hover:shadow-lg hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 transition-all">
            {analyze.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {analyze.isPending ? t('legalWatch.analyzer.analyzing') : t('legalWatch.analyzer.analyze')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Modale revue (diff viewer + actions) ───────────────────────────────────
function ProposalReviewModal({ id, onClose, onReviewed }: {
  id: string; onClose: () => void; onReviewed: () => void
}) {
  const { t } = useTranslation('platform')
  const { data, isLoading } = useQuery<{ data: ProposalDetail }>({
    queryKey: ['legal-watch-proposal', id],
    queryFn: () => api.get(`/platform/legal-watch/proposals/${id}`).then(r => r.data),
  })
  const [notes, setNotes] = useState('')
  const [view, setView] = useState<'side' | 'unified'>('side')

  const approve = useMutation({
    mutationFn: () => api.post(`/platform/legal-watch/proposals/${id}/approve`, { notes: notes || undefined }),
    onSuccess: onReviewed,
    onError: (e) => alert((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? t('legalWatch.review.error')),
  })
  const reject = useMutation({
    mutationFn: () => api.post(`/platform/legal-watch/proposals/${id}/reject`, { notes: notes || undefined }),
    onSuccess: onReviewed,
    onError: (e) => alert((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? t('legalWatch.review.error')),
  })

  const p = data?.data
  const isReadOnly = p?.status !== 'pending'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto"
      onClick={onClose}>
      <div className="w-full max-w-5xl rounded-2xl border border-border bg-card shadow-2xl my-auto flex flex-col max-h-[92vh]"
        onClick={e => e.stopPropagation()}>
        {isLoading || !p ? (
          <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-indigo-500" /></div>
        ) : (
          <>
            {/* Header */}
            <div className="border-b border-border bg-gradient-to-r from-slate-50 to-indigo-50 px-5 py-4 rounded-t-2xl">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_CONFIG[p.status].color}`}>
                      {t(`legalWatch.status.${p.status}`)}
                    </span>
                    {p.ai_confidence !== null && (
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${confidenceColor(p.ai_confidence)}`}>
                        <Sparkles className="inline h-3 w-3 mr-0.5" />{t('legalWatch.review.confidence', { confidence: p.ai_confidence })}
                      </span>
                    )}
                    <span className="text-[11px] text-slate-500 font-mono">{p.source} · {p.country_code}</span>
                  </div>
                  <h2 className="text-base font-bold text-slate-900 mt-1">
                    {p.current_title ?? t('legalWatch.review.newArticle')}
                  </h2>
                  {p.article_numero && (
                    <p className="text-xs text-slate-500 font-mono">{p.article_numero}</p>
                  )}
                </div>
                <button onClick={onClose} className="rounded-full p-1 hover:bg-slate-200" aria-label={t('common.close')}>
                  <XCircle className="h-5 w-5 text-slate-500" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {/* Résumé IA */}
              {p.diff_summary && (
                <div className="rounded-lg bg-indigo-50/50 border border-indigo-200 p-3">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-700 mb-1 flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" /> {t('legalWatch.review.aiSummary')}
                  </p>
                  <p className="text-sm text-slate-800">{p.diff_summary}</p>
                </div>
              )}

              {p.ai_reasoning && (
                <details className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                  <summary className="text-[11px] font-bold uppercase tracking-wider text-slate-600 cursor-pointer">
                    {t('legalWatch.review.aiReasoning')}
                  </summary>
                  <p className="text-sm text-slate-700 mt-2 leading-relaxed whitespace-pre-wrap">{p.ai_reasoning}</p>
                </details>
              )}

              {/* Toggle vue */}
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t('legalWatch.review.comparison')}</p>
                <div className="inline-flex gap-1 rounded-lg border border-border p-1 bg-slate-50">
                  {(['side', 'unified'] as const).map(v => (
                    <button key={v} onClick={() => setView(v)}
                      className={`rounded-md px-3 py-1 text-xs font-medium ${view === v ? 'bg-white shadow-sm' : 'text-slate-500'}`}>
                      {v === 'side' ? t('legalWatch.review.viewSide') : t('legalWatch.review.viewUnified')}
                    </button>
                  ))}
                </div>
              </div>

              {/* Diff viewer */}
              {view === 'side' ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-rose-700 mb-1 flex items-center gap-1.5">
                      <Eye className="h-3 w-3" /> {t('legalWatch.review.currentText')}
                    </p>
                    <div className="rounded-lg border border-rose-200 bg-rose-50/40 p-3 text-sm font-mono whitespace-pre-wrap text-slate-800 max-h-[50vh] overflow-y-auto leading-relaxed">
                      {p.current_text ?? <span className="italic text-slate-400">{t('legalWatch.review.currentTextEmpty')}</span>}
                    </div>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 mb-1 flex items-center gap-1.5">
                      <Sparkles className="h-3 w-3" /> {t('legalWatch.review.proposedText')}
                    </p>
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 text-sm font-mono whitespace-pre-wrap text-slate-800 max-h-[50vh] overflow-y-auto leading-relaxed">
                      {p.proposed_text}
                    </div>
                  </div>
                </div>
              ) : (
                <UnifiedDiff current={p.current_text ?? ''} proposed={p.proposed_text} />
              )}

              {/* Notes de revue */}
              {!isReadOnly && (
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
                    {t('legalWatch.review.notes')}
                  </label>
                  <textarea value={notes} onChange={e => setNotes(e.target.value)}
                    rows={2} maxLength={2000}
                    placeholder={t('legalWatch.review.notesPlaceholder')}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none" />
                </div>
              )}

              {isReadOnly && p.review_notes && (
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    {t('legalWatch.review.notesByLabel', { author: p.reviewed_by ?? t('legalWatch.review.defaultReviewer') })}
                  </p>
                  {p.review_notes}
                </div>
              )}
            </div>

            {/* Footer actions */}
            <div className="border-t border-border bg-slate-50 px-5 py-3 flex items-center justify-between rounded-b-2xl">
              <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700">
                {isReadOnly ? t('legalWatch.review.close') : t('legalWatch.review.cancel')}
              </button>
              {!isReadOnly && (
                <div className="flex items-center gap-2">
                  <button onClick={() => reject.mutate()}
                    disabled={reject.isPending || approve.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">
                    {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                    {t('legalWatch.review.reject')}
                  </button>
                  <button onClick={() => approve.mutate()}
                    disabled={approve.isPending || reject.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2 text-sm font-semibold text-white shadow-md hover:shadow-lg hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 transition-all">
                    {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    {t('legalWatch.review.approve')}
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Diff unifié simple (ligne par ligne) ───────────────────────────────────
function UnifiedDiff({ current, proposed }: { current: string; proposed: string }) {
  // Diff naïf ligne-à-ligne (sans LCS, suffisant pour MVP)
  const curLines = current.split('\n')
  const propLines = proposed.split('\n')
  const max = Math.max(curLines.length, propLines.length)
  const rows: Array<{ kind: 'same' | 'removed' | 'added'; text: string }> = []
  for (let i = 0; i < max; i++) {
    const a = curLines[i]
    const b = propLines[i]
    if (a === b) {
      if (a !== undefined) rows.push({ kind: 'same', text: a })
    } else {
      if (a !== undefined) rows.push({ kind: 'removed', text: a })
      if (b !== undefined) rows.push({ kind: 'added',   text: b })
    }
  }
  return (
    <div className="rounded-lg border border-border bg-slate-900 p-3 font-mono text-xs leading-relaxed max-h-[50vh] overflow-y-auto">
      {rows.map((r, i) => (
        <div key={i} className={`px-2 -mx-2 ${
          r.kind === 'removed' ? 'bg-rose-900/40 text-rose-200' :
          r.kind === 'added'   ? 'bg-emerald-900/40 text-emerald-200' :
                                  'text-slate-300'
        }`}>
          <span className="select-none mr-2 text-slate-500">
            {r.kind === 'removed' ? '-' : r.kind === 'added' ? '+' : ' '}
          </span>
          {r.text || ' '}
        </div>
      ))}
    </div>
  )
}
