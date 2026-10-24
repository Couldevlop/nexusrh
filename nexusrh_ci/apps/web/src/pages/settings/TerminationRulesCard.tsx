import { useState } from 'react'
import { useQuery, useMutation, type QueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Save, Trash2, RotateCcw, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'

// Règles de rupture (préavis + indemnité de licenciement) utilisées par le
// solde de tout compte : pays du tenant par défaut, convention collective du
// tenant si définie. L'API valide les paliers (croissants, dernier sans borne).
interface NoticeTier { upToSeniorityMonths: number | null; months: number }
interface SeveranceTier { upToYear: number | null; rate: number }
interface TerminationRules { noticeMonths: NoticeTier[]; severanceRates: SeveranceTier[] }
interface TerminationRulesView {
  legislationPackCode: string
  packRules: TerminationRules | null
  tenantRules: TerminationRules | null
  effectiveRules: TerminationRules | null
  source: 'tenant' | 'pack' | 'none'
}

// Ligne d'édition : borne vide = dernier palier (« au-delà »).
interface Row { bound: string; value: string }

const EMPTY_RULES: TerminationRules = {
  noticeMonths: [{ upToSeniorityMonths: null, months: 1 }],
  severanceRates: [{ upToYear: null, rate: 0.3 }],
}

const toRows = (tiers: Array<{ bound: number | null; value: number }>): Row[] =>
  tiers.map(t => ({ bound: t.bound === null ? '' : String(t.bound), value: String(t.value) }))

const fromRows = (rows: Row[]) =>
  rows.map((r, i) => ({ bound: i === rows.length - 1 ? null : Number(r.bound), value: Number(r.value.replace(',', '.')) }))

export default function TerminationRulesCard({ qc }: { qc: QueryClient }) {
  const { t } = useTranslation('settings')
  const { data } = useQuery<{ data: TerminationRulesView }>({
    queryKey: ['settings-termination-rules'],
    queryFn: () => api.get('/settings/termination-rules').then(r => r.data),
  })
  const [notice, setNotice] = useState<Row[] | null>(null)
  const [severance, setSeverance] = useState<Row[] | null>(null)

  const save = useMutation({
    mutationFn: (rules: TerminationRules | null) => api.put('/settings/termination-rules', { rules }),
    onSuccess: () => {
      setNotice(null); setSeverance(null)
      qc.invalidateQueries({ queryKey: ['settings-termination-rules'] })
    },
  })

  const view = data?.data
  if (!view) return null

  const editing = notice !== null && severance !== null
  const startEdit = () => {
    const base = view.effectiveRules ?? EMPTY_RULES
    setNotice(toRows(base.noticeMonths.map(n => ({ bound: n.upToSeniorityMonths, value: n.months }))))
    // Taux affiché en % pour la saisie.
    setSeverance(toRows(base.severanceRates.map(s => ({ bound: s.upToYear, value: Math.round(s.rate * 10000) / 100 }))))
  }
  const submit = () => {
    if (!notice || !severance) return
    save.mutate({
      noticeMonths: fromRows(notice).map(r => ({ upToSeniorityMonths: r.bound, months: r.value })),
      severanceRates: fromRows(severance).map(r => ({ upToYear: r.bound, rate: r.value / 100 })),
    })
  }

  const card = 'rounded-xl border border-border bg-card p-4 space-y-3'
  const inputCls = 'w-24 rounded-lg border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring'
  const rules = view.effectiveRules
  const apiError = (save.error as { response?: { data?: { error?: string; details?: Array<{ message: string }> } } } | null)
    ?.response?.data

  return (
    <div className={card}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-sm">{t('terminationRules.title')}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{t(`terminationRules.source.${view.source}`, { pack: view.legislationPackCode })}</p>
        </div>
        {!editing && (
          <div className="flex gap-2">
            {view.source === 'tenant' && (
              <button onClick={() => save.mutate(null)} disabled={save.isPending}
                className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted">
                <RotateCcw className="h-3.5 w-3.5" />{t('terminationRules.reset')}
              </button>
            )}
            <button onClick={startEdit}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted">
              {t('terminationRules.customize')}
            </button>
          </div>
        )}
      </div>

      {view.source === 'none' && !editing && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 p-3">
          <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800">{t('terminationRules.noneWarning')}</p>
        </div>
      )}

      {!editing && rules && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <TierList title={t('terminationRules.notice')} items={rules.noticeMonths.map((n, i) => ({
            label: n.upToSeniorityMonths === null
              ? (i === 0 ? t('terminationRules.allSeniority') : t('terminationRules.beyond'))
              : t('terminationRules.upToMonths', { n: n.upToSeniorityMonths }),
            value: t('terminationRules.months', { n: n.months }),
          }))} />
          <TierList title={t('terminationRules.severance')} items={rules.severanceRates.map((s, i) => ({
            label: s.upToYear === null
              ? (i === 0 ? t('terminationRules.allYears') : t('terminationRules.beyond'))
              : t('terminationRules.upToYear', { n: s.upToYear }),
            value: `${Math.round(s.rate * 10000) / 100} %`,
          }))} />
        </div>
      )}

      {editing && notice && severance && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">{t('terminationRules.editHint')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TierEditor title={t('terminationRules.notice')} boundLabel={t('terminationRules.boundMonths')}
              valueLabel={t('terminationRules.valueMonths')} rows={notice} onChange={setNotice} inputCls={inputCls} />
            <TierEditor title={t('terminationRules.severance')} boundLabel={t('terminationRules.boundYears')}
              valueLabel={t('terminationRules.valueRate')} rows={severance} onChange={setSeverance} inputCls={inputCls} />
          </div>
          {apiError && (
            <p className="text-xs text-red-600">
              {apiError.details?.map(d => d.message).join(' · ') || apiError.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => { setNotice(null); setSeverance(null) }}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">{t('terminationRules.cancel')}</button>
            <button onClick={submit} disabled={save.isPending}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
              <Save className="h-4 w-4" />{t('terminationRules.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function TierList({ title, items }: { title: string; items: Array<{ label: string; value: string }> }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</p>
      {items.map((it, i) => (
        <div key={i} className="flex justify-between">
          <span className="text-muted-foreground">{it.label}</span>
          <span className="font-mono">{it.value}</span>
        </div>
      ))}
    </div>
  )
}

function TierEditor({ title, boundLabel, valueLabel, rows, onChange, inputCls }: {
  title: string; boundLabel: string; valueLabel: string
  rows: Row[]; onChange: (rows: Row[]) => void; inputCls: string
}) {
  const { t } = useTranslation('settings')
  const update = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  // Nouveau palier inséré avant le dernier (qui reste « au-delà »).
  const add = () => onChange([...rows.slice(0, -1), { bound: '', value: rows[rows.length - 1]?.value ?? '0' }, rows[rows.length - 1]!])
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</p>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs text-muted-foreground">
        <span>{boundLabel}</span><span>{valueLabel}</span><span />
      </div>
      {rows.map((r, i) => {
        const last = i === rows.length - 1
        return (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
            {last
              ? <span className="text-sm text-muted-foreground">{t('terminationRules.beyond')}</span>
              : <input className={inputCls} type="number" min={0} value={r.bound} onChange={e => update(i, { bound: e.target.value })} />}
            <input className={inputCls} type="number" min={0} step="any" value={r.value} onChange={e => update(i, { value: e.target.value })} />
            {last ? <span className="w-6" /> : (
              <button type="button" onClick={() => remove(i)} className="text-muted-foreground hover:text-red-600">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        )
      })}
      <button type="button" onClick={add} className="flex items-center gap-1 text-xs text-primary hover:underline">
        <Plus className="h-3.5 w-3.5" />{t('terminationRules.addTier')}
      </button>
    </div>
  )
}
