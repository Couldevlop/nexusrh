import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'

// Champs personnalisés du dossier employé, définis par l'admin du tenant
// (Paramètres → Champs personnalisés). La validation fait foi côté API.
export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'boolean'
export interface CustomFieldDefinition {
  key: string; label: string; type: CustomFieldType
  required: boolean; sensitive: boolean; options?: string[]
}
export type CustomFieldValue = string | number | boolean
export type CustomFieldValues = Record<string, CustomFieldValue>

export function useEmployeeFieldDefinitions() {
  const { data } = useQuery<{ data: CustomFieldDefinition[] }>({
    queryKey: ['settings-employee-fields'],
    queryFn: () => api.get('/settings/employee-fields').then(r => r.data).catch(() => ({ data: [] })),
  })
  return data?.data ?? []
}

/** Valeur affichable d'un champ (lecture). */
export function formatCustomFieldValue(
  def: CustomFieldDefinition, value: CustomFieldValue | undefined, yesNo: { yes: string; no: string },
): string {
  if (value === undefined || value === '') return '—'
  if (def.type === 'boolean') return value ? yesNo.yes : yesNo.no
  if (def.type === 'date' && typeof value === 'string') return new Date(`${value}T00:00:00`).toLocaleDateString('fr-FR')
  return String(value)
}

/**
 * Bloc de saisie des champs personnalisés. `values` contient la saisie en
 * cours (ou les valeurs d'origine en modification) ; rien n'est rendu si le
 * tenant n'a défini aucun champ.
 */
export function CustomFieldsFieldset({ defs, values, onChange, inputCls, labelCls }: {
  defs: CustomFieldDefinition[]
  values: CustomFieldValues
  onChange: (key: string, value: CustomFieldValue) => void
  inputCls: string
  labelCls: string
}) {
  const { t } = useTranslation('employees')
  if (defs.length === 0) return null
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold mb-1">{t('customFields.section')}</legend>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {defs.map(def => {
          const v = values[def.key]
          const label = <label className={labelCls}>{def.label}{def.required ? ' *' : ''}</label>
          if (def.type === 'boolean') {
            return (
              <div key={def.key}>{label}
                <label className="flex items-center gap-2 text-sm mt-2">
                  <input type="checkbox" checked={v === true} onChange={e => onChange(def.key, e.target.checked)} />
                  {t('customFields.yes')}
                </label>
              </div>
            )
          }
          if (def.type === 'select') {
            return (
              <div key={def.key}>{label}
                <select className={inputCls} value={v === undefined ? '' : String(v)} required={def.required}
                  onChange={e => onChange(def.key, e.target.value)}>
                  <option value="">—</option>
                  {(def.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            )
          }
          return (
            <div key={def.key}>{label}
              <input className={inputCls} required={def.required}
                type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
                step={def.type === 'number' ? 'any' : undefined}
                maxLength={def.type === 'text' ? 500 : undefined}
                value={v === undefined ? '' : String(v)}
                onChange={e => onChange(def.key, e.target.value)} />
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}
