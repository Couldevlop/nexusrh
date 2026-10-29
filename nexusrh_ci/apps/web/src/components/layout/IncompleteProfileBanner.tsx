/**
 * Bandeau « fiche à compléter » de l'administrateur du tenant.
 *
 * À la création du tenant, l'admin reçoit une fiche employé minimale (salaire
 * de base 0) : elle est HORS PAIE tant que la rémunération n'est pas
 * renseignée. Le bandeau invite l'admin connecté à la compléter, avec un lien
 * direct vers sa fiche. Rien n'est rendu dans tous les autres cas (autre rôle,
 * aucune fiche liée, salaire renseigné, erreur de chargement).
 */
import { Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { UserCog } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { api } from '@/lib/api'

interface EmployeeSalaryRow {
  id: string
  base_salary: string | number | null
}

export default function IncompleteProfileBanner() {
  const { t } = useTranslation('nav')
  const location = useLocation()
  const user = useAuthStore(s => s.user)
  const employeeId = user?.role === 'admin' ? user.employeeId : null

  const { data } = useQuery<EmployeeSalaryRow | null>({
    queryKey: ['incomplete-profile', employeeId],
    enabled: !!employeeId,
    staleTime: 60_000,
    queryFn: async () => {
      try {
        const res = await api.get<{ data: EmployeeSalaryRow }>(`/employees/${employeeId}`)
        return res.data.data ?? null
      } catch {
        // Non bloquant : sans fiche lisible, pas de bandeau.
        return null
      }
    },
  })

  if (!employeeId || !data) return null
  const salary = Number(data.base_salary ?? 0)
  if (Number.isFinite(salary) && salary > 0) return null

  const href = `/employees/${employeeId}`
  const onOwnRecord = location.pathname === href

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <UserCog className="h-4 w-4 shrink-0" />
      <span className="flex-1">{t('incompleteProfile.message')}</span>
      {!onOwnRecord && (
        <Link to={href} className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline">
          {t('incompleteProfile.cta')}
        </Link>
      )}
    </div>
  )
}
