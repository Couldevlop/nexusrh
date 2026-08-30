/**
 * Revue du pré-tri — écran en deux volets, intercalé entre le dépôt et le kanban.
 *
 * Volet gauche  : les critères et leurs compteurs vivants. Les moteurs étant
 *                 purs côté serveur, `screening/preview` ne coûte ni écriture ni
 *                 appel IA : faire glisser un seuil recalcule le vivier en
 *                 direct et gratuitement, là où il fallait relancer un lot
 *                 d'analyses facturées.
 * Volet droit   : la file de revue, un dossier à la fois.
 *
 * Le principe tenu par cet écran : la machine propose, l'humain dispose. Un
 * verdict `flagged` n'est pas un rejet ; tant qu'aucune décision n'est prise, la
 * candidature n'entre pas dans le pipeline (RGPD art. 22).
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import {
  AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, FileText,
  Loader2, ShieldCheck, XCircle,
} from 'lucide-react'

export interface ScreeningQuestion {
  id: string
  label: string
  type: 'boolean' | 'number' | 'choice'
  options?: string[]
  required: boolean
  knockout?: boolean
}

export interface QueueItem {
  id: string
  first_name: string
  last_name: string
  email: string | null
  screening_verdict: 'pass' | 'flagged'
  screening_failed_rules: string[]
  screening_answers: Record<string, unknown>
  ai_score: number | null
  ai_summary: string | null
  has_cv: boolean
  created_at: string
}

interface Counters {
  total: number
  pass: number
  flagged: number
  pending: number
  byRule: Array<{ rule: string; count: number }>
}

export default function ScreeningReview({ jobId }: { jobId: string }) {
  const { t } = useTranslation('recruitment')
  const queryClient = useQueryClient()
  const [index, setIndex] = useState(0)
  const [reason, setReason] = useState('')
  const [needsReason, setNeedsReason] = useState<'kept' | 'dismissed' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const queue = useQuery({
    queryKey: ['screening-queue', jobId],
    queryFn: () => api.get(`/recruitment/jobs/${jobId}/screening/queue`).then(r => r.data.data),
  })

  const counters = useQuery({
    queryKey: ['screening-counters', jobId],
    queryFn: () => api.post(`/recruitment/jobs/${jobId}/screening/preview`, {})
      .then(r => r.data.data as Counters),
  })

  const items: QueueItem[] = useMemo(() => queue.data?.items ?? [], [queue.data])
  const questions: ScreeningQuestion[] = useMemo(() => queue.data?.questions ?? [], [queue.data])
  const current = items[index] ?? null

  // Le dossier courant change : on repart d'un formulaire de motif vierge.
  useEffect(() => { setReason(''); setNeedsReason(null); setError(null) }, [current?.id])

  const decide = useMutation({
    mutationFn: ({ decision, motif }: { decision: 'kept' | 'dismissed'; motif: string | null }) =>
      api.patch(`/recruitment/applications/${current!.id}/screening-decision`,
        { decision, ...(motif ? { reason: motif } : {}) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['screening-queue', jobId] })
      queryClient.invalidateQueries({ queryKey: ['screening-counters', jobId] })
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      setIndex(i => Math.max(0, Math.min(i, items.length - 2)))
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      setError(err?.response?.data?.error ?? t('screening.errorDecision'))
    },
  })

  /**
   * Une décision qui CONTREDIT le verdict machine exige un motif — dans les deux
   * sens : retenir un dossier signalé (dérogation) comme écarter un dossier
   * conforme. C'est la seule souplesse offerte, et elle est tracée : les
   * critères eux-mêmes ne varient jamais d'un candidat à l'autre, faute de quoi
   * l'égalité de traitement serait indémontrable.
   */
  const submit = (decision: 'kept' | 'dismissed') => {
    if (!current) return
    const contradicts = (decision === 'kept' && current.screening_verdict === 'flagged')
      || (decision === 'dismissed' && current.screening_verdict === 'pass')
    if (contradicts && reason.trim().length < 10) {
      setNeedsReason(decision)
      setError(null)
      return
    }
    decide.mutate({ decision, motif: reason.trim() || null })
  }

  if (queue.isLoading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {t('screening.loading')}
    </div>
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">

      {/* ── Volet gauche : critères et compteurs ─────────────────────────── */}
      <aside className="space-y-4">
        <section className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="h-4 w-4 text-primary" />
            {t('screening.countersTitle')}
          </h3>
          {counters.isLoading
            ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            : (
              <dl className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md bg-muted/40 p-2">
                  <dt className="text-[11px] text-muted-foreground">{t('screening.counters.total')}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{counters.data?.total ?? 0}</dd>
                </div>
                <div className="rounded-md bg-emerald-50 p-2 dark:bg-emerald-950/30">
                  <dt className="text-[11px] text-emerald-700 dark:text-emerald-400">{t('screening.counters.pass')}</dt>
                  <dd className="text-lg font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {counters.data?.pass ?? 0}
                  </dd>
                </div>
                <div className="rounded-md bg-amber-50 p-2 dark:bg-amber-950/30">
                  <dt className="text-[11px] text-amber-700 dark:text-amber-400">{t('screening.counters.flagged')}</dt>
                  <dd className="text-lg font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                    {counters.data?.flagged ?? 0}
                  </dd>
                </div>
              </dl>
            )}

          {/* Quel critère écarte le plus — l'information la plus utile pour régler
              un pré-tri, et celle qui manquait totalement jusqu'ici. */}
          {(counters.data?.byRule.length ?? 0) > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('screening.byRule')}
              </p>
              <ul className="space-y-1">
                {counters.data!.byRule.slice(0, 6).map(r => (
                  <li key={r.rule} className="flex items-start justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">{r.rule}</span>
                    <span className="shrink-0 font-semibold tabular-nums">{r.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('screening.discriminationWarning')}
        </p>
      </aside>

      {/* ── Volet droit : la file de revue ───────────────────────────────── */}
      <section className="rounded-lg border border-border bg-card">
        {!current ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <p className="text-sm font-medium">{t('screening.empty')}</p>
            <p className="max-w-sm text-xs text-muted-foreground">{t('screening.emptyHint')}</p>
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between border-b border-border p-4">
              <div>
                <h3 className="text-base font-semibold">
                  {current.first_name} {current.last_name}
                </h3>
                <p className="text-xs text-muted-foreground">{current.email}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${
                  current.screening_verdict === 'flagged'
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                    : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'}`}>
                  {t(`screening.verdict.${current.screening_verdict}`)}
                </span>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <button aria-label={t('screening.previous')} disabled={index === 0}
                    onClick={() => setIndex(i => Math.max(0, i - 1))}
                    className="rounded p-1 hover:bg-muted disabled:opacity-30">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="tabular-nums">{index + 1} / {items.length}</span>
                  <button aria-label={t('screening.next')} disabled={index >= items.length - 1}
                    onClick={() => setIndex(i => Math.min(items.length - 1, i + 1))}
                    className="rounded p-1 hover:bg-muted disabled:opacity-30">
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </header>

            <div className="space-y-4 p-4">
              {current.screening_failed_rules.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                  <p className="mb-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
                    {t('screening.failedRules')}
                  </p>
                  <ul className="list-inside list-disc space-y-0.5 text-xs text-amber-800 dark:text-amber-300">
                    {current.screening_failed_rules.map(r => <li key={r}>{r}</li>)}
                  </ul>
                </div>
              )}

              {questions.length > 0 && (
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('screening.answers')}
                  </p>
                  <dl className="space-y-1">
                    {questions.map(q => {
                      const a = current.screening_answers?.[q.id]
                      return (
                        <div key={q.id} className="flex items-start justify-between gap-3 text-xs">
                          <dt className="text-muted-foreground">{q.label}</dt>
                          <dd className="shrink-0 font-medium">
                            {a === undefined || a === null || a === ''
                              ? <span className="italic text-muted-foreground">{t('screening.noAnswer')}</span>
                              : typeof a === 'boolean' ? t(a ? 'screening.yes' : 'screening.no') : String(a)}
                          </dd>
                        </div>
                      )
                    })}
                  </dl>
                </div>
              )}

              {current.ai_summary && (
                <p className="rounded-md bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                  {current.ai_summary}
                </p>
              )}

              {current.has_cv && (
                <a href={`/recruitment/applications/${current.id}/cv-file`}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                  onClick={(e) => e.preventDefault()}>
                  <FileText className="h-3.5 w-3.5" /> {t('screening.hasCv')}
                </a>
              )}

              {needsReason && (
                <div>
                  <label htmlFor="screening-reason" className="mb-1 block text-xs font-medium">
                    {t('screening.reason')}
                  </label>
                  <textarea id="screening-reason" rows={2} value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={t('screening.reasonPlaceholder')}
                    className="w-full rounded-md border border-border bg-background p-2 text-xs" />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t('screening.reasonRequired')}
                  </p>
                </div>
              )}

              {error && <p className="text-xs font-medium text-destructive">{error}</p>}

              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                <button onClick={() => submit('kept')} disabled={decide.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                  <CheckCircle2 className="h-3.5 w-3.5" /> {t('screening.keep')}
                </button>
                <button onClick={() => submit('dismissed')} disabled={decide.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50">
                  <XCircle className="h-3.5 w-3.5" /> {t('screening.dismiss')}
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
