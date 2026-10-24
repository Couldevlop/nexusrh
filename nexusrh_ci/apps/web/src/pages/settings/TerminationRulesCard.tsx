import { useState } from 'react'
import { useQuery, useMutation, type QueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Save, Trash2, RotateCcw, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'

// Règles de rupture (préavis + indemnité de licenciement) utilisées par le
// solde de tout compte : pays du tenant par défaut, convention collective du
// tenant si définie. L'API valide les paliers (croissants, dernier sans borne).
// Le préavis peut varier selon la catégorie professionnelle et le mode de paie
// (CI : décret 96-200) : lignes `noticeByCategory`, barème par défaut sinon.
interface NoticeTier { upToSeniorityMonths: number | null; months: number; days?: number }
interface SeveranceTier { upToYear: number | null; rate: number }
interface NoticeCategoryRule {
  key: string; label: string
  minCategoryLevel?: number; maxCategoryLevel?: number; payBasis?: 'monthly' | 'non_monthly'
  tiers: NoticeTier[]
}
interface TerminationRules {
  noticeMonths: NoticeTier[]
  noticeByCategory?: NoticeCategoryRule[]
  severanceRates: SeveranceTier[]
  severanceMinSeniorityMonths?: number
}
interface TerminationRulesView {
  legislationPackCode: string
  packRules: TerminationRules | null
  tenantRules: TerminationRules | null
  effectiveRules: TerminationRules | null
  source: 'tenant' | 'pack' | 'none'
}

// Ligne d'édition : borne vide = dernier palier (« au-delà »).
interface Row { bound: string; value: string; days?: string }

interface Draft {
  notice: Row[]
  categories: Array<{ rule: NoticeCategoryRule; rows: Row[] }>
  severance: Row[]
}

const EMPTY_RULES: TerminationRules = {
  noticeMonths: [{ upToSeniorityMonths: null, months: 1 }],
  severanceRates: [{ upToYear: null, rate: 0.3 }],
}

const num = (v: string) => Number(v.replace(',', '.'))

const noticeToRows = (tiers: NoticeTier[]): Row[] => tiers.map(t => ({
  bound: t.upToSeniorityMonths === null ? '' : String(t.upToSeniorityMonths),
  value: String(t.months), days: t.days ? String(t.days) : '',
}))

const rowsToNotice = (rows: Row[]): NoticeTier[] => rows.map((r, i) => {
  const days = r.days?.trim() ? num(r.days) : 0
  return {
    upToSeniorityMonths: i === rows.length - 1 ? null : num(r.bound),
    months: num(r.value || '0'),
    ...(days > 0 ? { days } : {}),
  }
})

export default function TerminationRulesCard({ qc }: { qc: QueryClient }) {
  const { t } = useTranslation('settings')
  const { data } = useQuery<{ data: TerminationRulesView }>({
    queryKey: ['settings-termination-rules'],
    queryFn: () => api.get('/settings/termination-rules').then(r => r.data),
  })
  const [draft, setDraft] = useState<Draft | null>(null)

  const save = useMutation({
    mutationFn: (rules: TerminationRules | null) => api.put('/settings/termination-rules', { rules }),
    onSuccess: () => {
      setDraft(null)
      qc.invalidateQueries({ queryKey: ['settings-termination-rules'] })
    },
  })

  const view = data?.data
  if (!view) return null

  const base = view.effectiveRules ?? EMPTY_RULES
  const startEdit = () => setDraft({
    notice: noticeToRows(base.noticeMonths),
    categories: (base.noticeByCategory ?? []).map(rule => ({ rule, rows: noticeToRows(rule.tiers) })),
    // Taux affiché en % pour la saisie.
    severance: base.severanceRates.map(s => ({
      bound: s.upToYear === null ? '' : String(s.upToYear), value: String(Math.round(s.rate * 10000) / 100),
    })),
  })
  const submit = () => {
    if (!draft) return
    const categories = draft.categories.map(c => ({ ...c.rule, tiers: rowsToNotice(c.rows) }))
    save.mutate({
      noticeMonths: rowsToNotice(draft.notice),
      ...(categories.length ? { noticeByCategory: categories } : {}),
      severanceRates: draft.severance.map((r, i) => ({
        upToYear: i === draft.severance.length - 1 ? null : num(r.bound), rate: num(r.value) / 100,
      })),
      // Seuil d'ouverture du droit conservé (non éditable ici).
      ...(base.severanceMinSeniorityMonths !== undefined ? { severanceMinSeniorityMonths: base.severanceMinSeniorityMonths } : {}),
    })
  }

  const card = 'rounded-xl border border-border bg-card p-4 space-y-3'
  const inputCls = 'w-full min-w-0 rounded-lg border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring'
  const rules = view.effectiveRules
  const apiError = (save.error as { response?: { data?: { error?: string; details?: Array<{ message: string }> } } } | null)
    ?.response?.data

  const noticeItems = (tiers: NoticeTier[]) => tiers.map((n, i) => ({
    label: n.upToSeniorityMonths === null
      ? (i === 0 ? t('terminationRules.allSeniority') : t('terminationRules.beyond'))
      : t('terminationRules.upToMonths', { n: n.upToSeniorityMonths }),
    value: [n.months ? t('terminationRules.months', { n: n.months }) : '', n.days ? t('terminationRules.days', { n: n.days }) : '']
      .filter(Boolean).join(' + ') || t('terminationRules.months', { n: 0 }),
  }))

  return (
    <div className={card}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-sm">{t('terminationRules.title')}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{t(`terminationRules.source.${view.source}`, { pack: view.legislationPackCode })}</p>
        </div>
        {!draft && (
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

      {view.source === 'none' && !draft && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 p-3">
          <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800">{t('terminationRules.noneWarning')}</p>
        </div>
      )}

      {!draft && rules && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div className="space-y-4">
            {(rules.noticeByCategory ?? []).map(c => (
              <TierList key={c.key} title={`${t('terminationRules.notice')} — ${c.label}`} items={noticeItems(c.tiers)} />
            ))}
            <TierList
              title={rules.noticeByCategory?.length ? `${t('terminationRules.notice')} — ${t('terminationRules.defaultScale')}` : t('terminationRules.notice')}
              hint={rules.noticeByCategory?.length ? t('terminationRules.defaultScaleHint') : undefined}
              items={noticeItems(rules.noticeMonths)} />
          </div>
          <div className="space-y-1.5">
            <TierList title={t('terminationRules.severance')} items={rules.severanceRates.map((s, i) => ({
              label: s.upToYear === null
                ? (i === 0 ? t('terminationRules.allYears') : t('terminationRules.beyond'))
                : t('terminationRules.upToYear', { n: s.upToYear }),
              value: `${Math.round(s.rate * 10000) / 100} %`,
            }))} />
            {rules.severanceMinSeniorityMonths !== undefined && (
              <p className="text-xs text-muted-foreground">{t('terminationRules.minSeniority', { n: rules.severanceMinSeniorityMonths })}</p>
            )}
          </div>
        </div>
      )}

      {draft && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">{t('terminationRules.editHint')}</p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-4">
              {draft.categories.map((c, ci) => (
                <TierEditor key={c.rule.key} title={`${t('terminationRules.notice')} — ${c.rule.label}`}
                  boundLabel={t('terminationRules.boundMonths')} valueLabel={t('terminationRules.valueMonths')}
                  daysLabel={t('terminationRules.valueDays')} rows={c.rows} inputCls={inputCls}
                  onChange={rows => setDraft({ ...draft, categories: draft.categories.map((x, j) => (j === ci ? { ...x, rows } : x)) })} />
              ))}
              <TierEditor
                title={draft.categories.length ? `${t('terminationRules.notice')} — ${t('terminationRules.defaultScale')}` : t('terminationRules.notice')}
                boundLabel={t('terminationRules.boundMonths')} valueLabel={t('terminationRules.valueMonths')}
                daysLabel={t('terminationRules.valueDays')} rows={draft.notice} inputCls={inputCls}
                onChange={notice => setDraft({ ...draft, notice })} />
            </div>
            <TierEditor title={t('terminationRules.severance')} boundLabel={t('terminationRules.boundYears')}
              valueLabel={t('terminationRules.valueRate')} rows={draft.severance} inputCls={inputCls}
              onChange={severance => setDraft({ ...draft, severance })} />
          </div>
          {apiError && (
            <p className="text-xs text-red-600">
              {apiError.details?.map(d => d.message).join(' · ') || apiError.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setDraft(null)}
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

function TierList({ title, hint, items }: { title: string; hint?: string; items: Array<{ label: string; value: string }> }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {items.map((it, i) => (
        <div key={i} className="flex justify-between gap-2">
          <span className="text-muted-foreground">{it.label}</span>
          <span className="font-mono whitespace-nowrap">{it.value}</span>
        </div>
      ))}
    </div>
  )
}

function TierEditor({ title, boundLabel, valueLabel, daysLabel, rows, onChange, inputCls }: {
  title: string; boundLabel: string; valueLabel: string; daysLabel?: string
  rows: Row[]; onChange: (rows: Row[]) => void; inputCls: string
}) {
  const { t } = useTranslation('settings')
  const update = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  // Nouveau palier inséré avant le dernier (qui reste « au-delà »).
  const add = () => {
    const last = rows[rows.length - 1]!
    onChange([...rows.slice(0, -1), { bound: '', value: last.value, days: '' }, last])
  }
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))
  const cols = daysLabel ? 'grid-cols-[1fr_1fr_1fr_auto]' : 'grid-cols-[1fr_1fr_auto]'
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</p>
      <div className={`grid ${cols} gap-2 text-xs text-muted-foreground`}>
        <span>{boundLabel}</span><span>{valueLabel}</span>{daysLabel && <span>{daysLabel}</span>}<span />
      </div>
      {rows.map((r, i) => {
        const last = i === rows.length - 1
        return (
          <div key={i} className={`grid ${cols} gap-2 items-center`}>
            {last
              ? <span className="text-sm text-muted-foreground">{t('terminationRules.beyond')}</span>
              : <input className={inputCls} type="number" min={0} value={r.bound} onChange={e => update(i, { bound: e.target.value })} />}
            <input className={inputCls} type="number" min={0} step="any" value={r.value} onChange={e => update(i, { value: e.target.value })} />
            {daysLabel && (
              <input className={inputCls} type="number" min={0} max={60} step={1} value={r.days ?? ''} onChange={e => update(i, { days: e.target.value })} />
            )}
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
