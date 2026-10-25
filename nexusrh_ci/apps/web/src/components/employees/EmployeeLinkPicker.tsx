/**
 * Sélection de la fiche employé à rattacher à un compte utilisateur
 * (lien explicite users.employee_id). Recherche serveur (nom / N° CNPS) pour
 * rester utilisable sur les gros effectifs ; les fiches déjà liées à un AUTRE
 * compte sont affichées mais non sélectionnables (1 compte ↔ 1 fiche).
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'

export interface LinkableEmployee {
  id: string; first_name: string; last_name: string; email: string | null
  job_title?: string | null; linked_user_id?: string | null
}

interface Props {
  value: string
  onChange: (employeeId: string, employee: LinkableEmployee | null) => void
  /** Compte en cours d'édition : sa propre fiche reste sélectionnable. */
  currentUserId?: string | null
  /** Fiche actuellement liée (affichée même si hors des résultats de recherche). */
  currentEmployee?: { id: string; label: string } | null
  id?: string
}

export function EmployeeLinkPicker({ value, onChange, currentUserId = null, currentEmployee = null, id }: Props) {
  const { t } = useTranslation('settings')
  const [search, setSearch] = useState('')
  const { data, isFetching } = useQuery<{ data: LinkableEmployee[] }>({
    queryKey: ['employees-link-picker', search],
    queryFn: () => api.get('/employees', { params: { search: search || undefined, limit: 50 } }).then(r => r.data),
  })
  const employees = data?.data ?? []
  const showCurrent = currentEmployee && !employees.some(e => e.id === currentEmployee.id)

  return (
    <div className="space-y-1.5">
      <input
        type="search"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder={t('users.employeeLink.searchPlaceholder')}
        aria-label={t('users.employeeLink.searchPlaceholder')}
        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value, employees.find(x => x.id === e.target.value) ?? null)}
        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="">{t('users.employeeLink.none')}</option>
        {showCurrent && <option value={currentEmployee.id}>{currentEmployee.label}</option>}
        {employees.map(e => {
          const takenByOther = !!e.linked_user_id && e.linked_user_id !== currentUserId
          return (
            <option key={e.id} value={e.id} disabled={takenByOther}>
              {e.last_name} {e.first_name}{e.job_title ? ` · ${e.job_title}` : ''}
              {takenByOther ? ` (${t('users.employeeLink.alreadyLinked')})` : ''}
            </option>
          )
        })}
      </select>
      {isFetching && <p className="text-xs text-muted-foreground">{t('users.employeeLink.loading')}</p>}
    </div>
  )
}
