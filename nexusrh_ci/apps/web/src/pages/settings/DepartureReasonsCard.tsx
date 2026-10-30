import { useState } from 'react'
import { useQuery, useMutation, type QueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Save, Trash2, RotateCcw, AlertCircle, ArrowUp, ArrowDown } from 'lucide-react'
import { api } from '@/lib/api'

// Catégories de motifs de départ (marque employeur) : liste paramétrable du
// tenant, choisie obligatoirement à l'ouverture d'un dossier de sortie et
// utilisée comme axe d'agrégation des statistiques de départ. La CLÉ est
// stockée sur les dossiers : la modifier ou la retirer ne réécrit pas les
// dossiers déjà classés. L'API valide (clés uniques, 1 à 30 entrées).
interface DepartureReasonCategory { key: string; label: string }
interface DepartureReasonsView {
  data: DepartureReasonCategory[]
  customized: boolean
  defaults: DepartureReasonCategory[]
}

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/
const MAX_CATEGORIES = 30

/** Clé technique dérivée du libellé (sans accents, minuscules, `_`). */
function slugifyReasonKey(label: string): string {
  const base = label
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 40)
  if (!base) return ''
  return /^[a-z]/.test(base) ? base : `m_${base}`.slice(0, 40)
}

export default function DepartureReasonsCard({ qc }: { qc: QueryClient }) {
  const { t } = useTranslation('settings')
  const { data } = useQuery<DepartureReasonsView>({
    queryKey: ['settings', 'departure-reasons', 'admin'],
    queryFn: () => api.get('/settings/departure-reasons').then(r => r.data as DepartureReasonsView),
  })
  const [draft, setDraft] = useState<DepartureReasonCategory[] | null>(null)

  const invalidate = () => {
    setDraft(null)
    void qc.invalidateQueries({ queryKey: ['settings', 'departure-reasons'] })
  }
  const save = useMutation({
    mutationFn: (categories: DepartureReasonCategory[]) => api.put('/settings/departure-reasons', { categories }),
    onSuccess: invalidate,
  })
  const reset = useMutation({
    mutationFn: () => api.put('/settings/departure-reasons', { reset: true }),
    onSuccess: invalidate,
  })

  if (!data) return null

  const card = 'rounded-xl border border-border bg-card p-4 space-y-3'
  const inputCls = 'w-full min-w-0 rounded-lg border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring'
  const apiError = (save.error as { response?: { data?: { error?: string; details?: Array<{ message: string }> } } } | null)
    ?.response?.data

  const keys = (draft ?? []).map(c => c.key)
  const issues: string[] = []
  if (draft) {
    if (draft.length === 0) issues.push(t('departureReasons.errors.empty'))
    if (draft.some(c => !c.label.trim())) issues.push(t('departureReasons.errors.label'))
    if (draft.some(c => !KEY_RE.test(c.key))) issues.push(t('departureReasons.errors.key'))
    if (new Set(keys).size !== keys.length) issues.push(t('departureReasons.errors.duplicate'))
  }

  const update = (i: number, patch: Partial<DepartureReasonCategory>) =>
    setDraft(d => d ? d.map((c, j) => j === i ? { ...c, ...patch } : c) : d)
  const move = (i: number, delta: number) => setDraft(d => {
    if (!d) return d
    const j = i + delta
    if (j < 0 || j >= d.length) return d
    const a = d[i]
    const b = d[j]
    if (!a || !b) return d
    const next = [...d]
    next[i] = b
    next[j] = a
    return next
  })
  // Clé générée depuis le libellé tant que la ligne est nouvelle (clé vide ou
  // encore dérivée) ; une clé existante n'est jamais réécrite en silence.
  const original = new Set(data.data.map(c => c.key))

  return (
    <div className={card}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-sm">{t('departureReasons.title')}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {data.customized ? t('departureReasons.sourceTenant') : t('departureReasons.sourceDefault')}
          </p>
        </div>
        {!draft && (
          <div className="flex gap-2">
            {data.customized && (
              <button type="button" onClick={() => reset.mutate()} disabled={reset.isPending}
                className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted">
                <RotateCcw className="h-3.5 w-3.5" /> {t('departureReasons.reset')}
              </button>
            )}
            <button type="button" onClick={() => setDraft(data.data.map(c => ({ ...c })))}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">
              {t('departureReasons.edit')}
            </button>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t('departureReasons.hint')}</p>

      {!draft && (
        <ul className="flex flex-wrap gap-1.5">
          {data.data.map(c => (
            <li key={c.key} className="rounded-full bg-muted px-2.5 py-0.5 text-xs" title={c.key}>{c.label}</li>
          ))}
        </ul>
      )}

      {draft && (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span>{t('departureReasons.label')}</span><span>{t('departureReasons.key')}</span><span />
          </div>
          {draft.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
              <input value={c.label} maxLength={100} aria-label={t('departureReasons.label')}
                onChange={e => {
                  const label = e.target.value
                  const auto = !original.has(c.key) && (c.key === '' || c.key === slugifyReasonKey(c.label))
                  update(i, auto ? { label, key: slugifyReasonKey(label) } : { label })
                }}
                className={inputCls} />
              <input value={c.key} maxLength={40} aria-label={t('departureReasons.key')}
                onChange={e => update(i, { key: e.target.value.trim() })}
                className={`${inputCls} font-mono`} />
              <div className="flex gap-0.5">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title={t('departureReasons.up')}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === draft.length - 1} title={t('departureReasons.down')}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => setDraft(d => d ? d.filter((_, j) => j !== i) : d)} title={t('departureReasons.remove')}
                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))}
          {draft.length < MAX_CATEGORIES && (
            <button type="button" onClick={() => setDraft(d => d ? [...d, { key: '', label: '' }] : d)}
              className="flex items-center gap-1 text-xs text-primary hover:underline">
              <Plus className="h-3.5 w-3.5" /> {t('departureReasons.add')}
            </button>
          )}
          <p className="text-[11px] text-muted-foreground">{t('departureReasons.keyHint')}</p>

          {(issues.length > 0 || apiError) && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive space-y-0.5">
              {issues.map(m => <p key={m} className="flex items-start gap-1"><AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />{m}</p>)}
              {apiError && (
                <p className="flex items-start gap-1">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
                  {[apiError.error, ...(apiError.details ?? []).map(d => d.message)].filter(Boolean).join(' — ')}
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setDraft(null); save.reset() }}
              className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted">{t('departureReasons.cancel')}</button>
            <button type="button" disabled={issues.length > 0 || save.isPending}
              onClick={() => save.mutate(draft.map(c => ({ key: c.key, label: c.label.trim() })))}
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50">
              <Save className="h-3.5 w-3.5" /> {save.isPending ? t('departureReasons.saving') : t('departureReasons.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
