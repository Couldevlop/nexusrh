import { useState } from 'react'
import { useQuery, useMutation, type QueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Save, Trash2, RotateCcw, AlertCircle, ArrowUp, ArrowDown } from 'lucide-react'
import { api } from '@/lib/api'

// Grille de classification professionnelle du tenant : les catégories de sa
// CONVENTION COLLECTIVE, avec le minimum conventionnel de chacune. Ce n'est pas
// une donnée légale — il n'y a donc aucune liste par défaut, et tant que
// l'admin n'a rien saisi les écrans concernés gardent la saisie libre.
//
// Le pays est facultatif : un tenant mono-pays laisse la colonne vide. Un
// groupe multi-pays rattache chaque catégorie à sa filiale, pour qu'une grille
// signée en Côte d'Ivoire ne propose pas son minimum à une embauche béninoise.
export interface ProfessionalCategory {
  key: string
  label: string
  minimum: number | null
  countryCode: string | null
}
interface ProfessionalCategoriesView {
  data: ProfessionalCategory[]
  configured: boolean
  max: number
}
interface CountryOption { countryCode: string; name: string }

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/

/** Clé technique dérivée du libellé (sans accents, minuscules, `_`). */
function slugifyCategoryKey(label: string): string {
  const base = label
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 40)
  if (!base) return ''
  return /^[a-z]/.test(base) ? base : `c_${base}`.slice(0, 40)
}

export default function ProfessionalCategoriesCard({
  qc, countries, currency,
}: { qc: QueryClient; countries: CountryOption[]; currency: string }) {
  const { t } = useTranslation('settings')
  const { data } = useQuery<ProfessionalCategoriesView>({
    queryKey: ['settings', 'professional-categories', 'admin'],
    queryFn: () => api.get('/settings/professional-categories').then(r => r.data as ProfessionalCategoriesView),
  })
  const [draft, setDraft] = useState<ProfessionalCategory[] | null>(null)

  const invalidate = () => {
    setDraft(null)
    void qc.invalidateQueries({ queryKey: ['settings', 'professional-categories'] })
  }
  const save = useMutation({
    mutationFn: (categories: ProfessionalCategory[]) => api.put('/settings/professional-categories', { categories }),
    onSuccess: invalidate,
  })
  const reset = useMutation({
    mutationFn: () => api.put('/settings/professional-categories', { reset: true }),
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
    if (draft.length === 0) issues.push(t('professionalCategories.errors.empty'))
    if (draft.some(c => !c.label.trim())) issues.push(t('professionalCategories.errors.label'))
    if (draft.some(c => !KEY_RE.test(c.key))) issues.push(t('professionalCategories.errors.key'))
    if (new Set(keys).size !== keys.length) issues.push(t('professionalCategories.errors.duplicate'))
    // Un minimum à 0 n'est pas « non renseigné » : l'API le refuse, autant le
    // dire ici plutôt que de laisser l'enregistrement échouer.
    if (draft.some(c => c.minimum !== null && !(Number.isInteger(c.minimum) && c.minimum > 0))) {
      issues.push(t('professionalCategories.errors.minimum'))
    }
  }

  const update = (i: number, patch: Partial<ProfessionalCategory>) =>
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
  const original = new Set(data.data.map(c => c.key))
  const money = (n: number) => new Intl.NumberFormat('fr-FR').format(n).replace(/ /g, ' ')
  const paysLabel = (code: string | null) =>
    code === null ? t('professionalCategories.allCountries')
      : countries.find(c => c.countryCode === code)?.name ?? code

  return (
    <div className={card}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-sm">{t('professionalCategories.title')}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {data.configured ? t('professionalCategories.sourceTenant') : t('professionalCategories.sourceNone')}
          </p>
        </div>
        {!draft && (
          <div className="flex gap-2">
            {data.configured && (
              <button type="button" onClick={() => reset.mutate()} disabled={reset.isPending}
                className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted">
                <RotateCcw className="h-3.5 w-3.5" /> {t('professionalCategories.reset')}
              </button>
            )}
            <button type="button"
              onClick={() => setDraft(data.data.length > 0
                ? data.data.map(c => ({ ...c }))
                : [{ key: '', label: '', minimum: null, countryCode: null }])}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">
              {data.configured ? t('professionalCategories.edit') : t('professionalCategories.create')}
            </button>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t('professionalCategories.hint')}</p>

      {!draft && data.data.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              <th className="py-1.5">{t('professionalCategories.label')}</th>
              <th className="py-1.5 text-right">{t('professionalCategories.minimum', { currency })}</th>
              <th className="py-1.5">{t('professionalCategories.country')}</th>
            </tr>
          </thead>
          <tbody>
            {data.data.map(c => (
              <tr key={c.key} className="border-b border-border/50 last:border-0">
                <td className="py-1.5" title={c.key}>{c.label}</td>
                <td className="py-1.5 text-right font-mono">
                  {c.minimum === null
                    ? <span className="text-muted-foreground">{t('professionalCategories.minimumUnset')}</span>
                    : money(c.minimum)}
                </td>
                <td className="py-1.5 text-xs text-muted-foreground">{paysLabel(c.countryCode)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {draft && (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span>{t('professionalCategories.label')}</span>
            <span>{t('professionalCategories.key')}</span>
            <span>{t('professionalCategories.minimum', { currency })}</span>
            <span>{t('professionalCategories.country')}</span>
            <span />
          </div>
          {draft.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto_auto] items-center gap-2">
              <input value={c.label} maxLength={100} aria-label={t('professionalCategories.label')}
                placeholder={t('professionalCategories.labelPlaceholder')}
                onChange={e => {
                  const label = e.target.value
                  const auto = !original.has(c.key) && (c.key === '' || c.key === slugifyCategoryKey(c.label))
                  update(i, auto ? { label, key: slugifyCategoryKey(label) } : { label })
                }}
                className={inputCls} />
              <input value={c.key} maxLength={40} aria-label={t('professionalCategories.key')}
                onChange={e => update(i, { key: e.target.value.trim() })}
                className={`${inputCls} font-mono`} />
              <input type="number" min={0} step={5000} className={`${inputCls} w-28`}
                aria-label={t('professionalCategories.minimum', { currency })}
                placeholder={t('professionalCategories.minimumUnset')}
                value={c.minimum ?? ''}
                onChange={e => {
                  const v = e.target.value.trim()
                  update(i, { minimum: v === '' ? null : Math.trunc(Number(v)) })
                }} />
              <select className={`${inputCls} w-36`} value={c.countryCode ?? ''}
                aria-label={t('professionalCategories.country')}
                onChange={e => update(i, { countryCode: e.target.value === '' ? null : e.target.value })}>
                <option value="">{t('professionalCategories.allCountries')}</option>
                {countries.map(p => <option key={p.countryCode} value={p.countryCode}>{p.name}</option>)}
              </select>
              <div className="flex gap-0.5">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title={t('professionalCategories.up')}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === draft.length - 1} title={t('professionalCategories.down')}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => setDraft(d => d ? d.filter((_, j) => j !== i) : d)} title={t('professionalCategories.remove')}
                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))}
          {draft.length < data.max && (
            <button type="button"
              onClick={() => setDraft(d => d ? [...d, { key: '', label: '', minimum: null, countryCode: null }] : d)}
              className="flex items-center gap-1 text-xs text-primary hover:underline">
              <Plus className="h-3.5 w-3.5" /> {t('professionalCategories.add')}
            </button>
          )}
          <p className="text-[11px] text-muted-foreground">{t('professionalCategories.keyHint')}</p>
          <p className="text-[11px] text-muted-foreground">{t('professionalCategories.countryHint')}</p>

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
              className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted">{t('professionalCategories.cancel')}</button>
            <button type="button" disabled={issues.length > 0 || save.isPending}
              onClick={() => save.mutate(draft.map(c => ({
                key: c.key, label: c.label.trim(), minimum: c.minimum, countryCode: c.countryCode,
              })))}
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50">
              <Save className="h-3.5 w-3.5" /> {save.isPending ? t('professionalCategories.saving') : t('professionalCategories.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
