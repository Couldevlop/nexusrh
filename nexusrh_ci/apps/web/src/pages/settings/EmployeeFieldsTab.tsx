import { useState } from 'react'
import { useQuery, useMutation, type QueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ListPlus, Plus, Save, Trash2, ArrowUp, ArrowDown, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { CustomFieldDefinition, CustomFieldType } from '@/components/employees/CustomFields'

const TYPES: CustomFieldType[] = ['text', 'number', 'date', 'select', 'boolean']
const MAX_FIELDS = 30

// Ligne d'édition : options saisies en texte (une par ligne) pour les listes.
interface Draft extends Omit<CustomFieldDefinition, 'options'> { optionsText: string; isNew: boolean }

/** Clé technique dérivée du libellé (minuscules, sans accents, _). */
export function keyFromLabel(label: string, taken: Set<string>): string {
  let base = label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36)
  if (!/^[a-z]/.test(base)) base = `c_${base}`.replace(/_+$/, '')
  if (base.length < 2) base = 'champ'
  let key = base
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`
  return key
}

const toDraft = (d: CustomFieldDefinition): Draft => ({ ...d, optionsText: (d.options ?? []).join('\n'), isNew: false })

const toDefinition = (d: Draft): CustomFieldDefinition => {
  const options = d.optionsText.split('\n').map(o => o.trim()).filter(Boolean)
  return {
    key: d.key, label: d.label.trim(), type: d.type, required: d.required, sensitive: d.sensitive,
    ...(d.type === 'select' ? { options } : {}),
  }
}

/** Onglet Paramètres → Champs personnalisés du dossier employé (admin). */
export default function EmployeeFieldsTab({ qc }: { qc: QueryClient }) {
  const { t } = useTranslation('settings')
  const { data, isLoading } = useQuery<{ data: CustomFieldDefinition[] }>({
    queryKey: ['settings-employee-fields'],
    queryFn: () => api.get('/settings/employee-fields').then(r => r.data),
  })
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [saved, setSaved] = useState(false)
  const rows = drafts ?? (data?.data ?? []).map(toDraft)

  const save = useMutation({
    mutationFn: () => api.put('/settings/employee-fields', { fields: rows.map(toDefinition) }),
    onSuccess: () => {
      setDrafts(null); setSaved(true)
      qc.invalidateQueries({ queryKey: ['settings-employee-fields'] })
      setTimeout(() => setSaved(false), 2500)
    },
  })

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">{t('loading')}</div>

  const edit = (next: Draft[]) => setDrafts(next)
  const update = (i: number, patch: Partial<Draft>) => {
    edit(rows.map((r, j) => {
      if (j !== i) return r
      const merged = { ...r, ...patch }
      // Clé dérivée du libellé tant que le champ n'est pas enregistré ; ensuite
      // figée (la renommer orphelinerait les valeurs déjà saisies).
      if (r.isNew && patch.label !== undefined) {
        merged.key = keyFromLabel(patch.label, new Set(rows.filter((_, k) => k !== i).map(x => x.key)))
      }
      return merged
    }))
  }
  const add = () => edit([...rows, {
    key: keyFromLabel('champ', new Set(rows.map(r => r.key))), label: '', type: 'text',
    required: false, sensitive: false, optionsText: '', isNew: true,
  }])
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rows.length) return
    const next = [...rows]; [next[i], next[j]] = [next[j]!, next[i]!]
    edit(next)
  }

  const inputCls = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
  const apiError = (save.error as { response?: { data?: { error?: string; details?: Array<{ path: string; message: string }> } } } | null)
    ?.response?.data

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <ListPlus className="h-5 w-5 text-primary" />{t('employeeFields.title')}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">{t('employeeFields.subtitle')}</p>
      </div>

      {rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t('employeeFields.empty')}
        </p>
      )}

      {rows.map((r, i) => (
        <div key={i} className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('employeeFields.label')}</label>
              <input className={inputCls} value={r.label} maxLength={80} onChange={e => update(i, { label: e.target.value })} />
              <p className="text-[11px] text-muted-foreground mt-1 font-mono">{t('employeeFields.key')} : {r.key}</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('employeeFields.type')}</label>
              <select className={inputCls} value={r.type} onChange={e => update(i, { type: e.target.value as CustomFieldType })}>
                {TYPES.map(ty => <option key={ty} value={ty}>{t(`employeeFields.types.${ty}`)}</option>)}
              </select>
            </div>
          </div>
          {r.type === 'select' && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('employeeFields.options')}</label>
              <textarea className={inputCls} rows={3} value={r.optionsText}
                onChange={e => update(i, { optionsText: e.target.value })} placeholder={t('employeeFields.optionsHint')} />
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={r.required} onChange={e => update(i, { required: e.target.checked })} />
                {t('employeeFields.required')}
              </label>
              <label className="flex items-center gap-2" title={t('employeeFields.sensitiveHint')}>
                <input type="checkbox" checked={r.sensitive} onChange={e => update(i, { sensitive: e.target.checked })} />
                {t('employeeFields.sensitive')}
              </label>
            </div>
            <div className="flex items-center gap-1 text-muted-foreground">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="p-1 hover:text-foreground disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === rows.length - 1} className="p-1 hover:text-foreground disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
              <button type="button" onClick={() => edit(rows.filter((_, j) => j !== i))} className="p-1 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
            </div>
          </div>
        </div>
      ))}

      <p className="text-xs text-muted-foreground">{t('employeeFields.removeHint')}</p>

      {apiError && (
        <p className="text-sm text-red-600">{apiError.details?.map(d => d.message).join(' · ') || apiError.error}</p>
      )}

      <div className="flex items-center justify-between">
        <button type="button" onClick={add} disabled={rows.length >= MAX_FIELDS}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50">
          <Plus className="h-4 w-4" />{t('employeeFields.add')}
        </button>
        <div className="flex items-center gap-2">
          {saved && <span className="flex items-center gap-1 text-xs text-green-600"><CheckCircle2 className="h-3.5 w-3.5" />{t('employeeFields.saved')}</span>}
          <button onClick={() => save.mutate()} disabled={drafts === null || save.isPending || rows.some(r => !r.label.trim())}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Save className="h-4 w-4" />{t('employeeFields.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
