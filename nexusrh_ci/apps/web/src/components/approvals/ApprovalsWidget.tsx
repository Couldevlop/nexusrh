/**
 * Carte « Mes validations » du tableau de bord : compteurs (à traiter, en
 * retard, échéance proche) et les 5 premières demandes, triées par échéance
 * côté API. Masquée quand l'utilisateur n'a aucune demande à suivre.
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowRight, ListChecks } from 'lucide-react'
import { SlaBadge, WorkflowStep } from './WorkflowBadges'
import { usePendingApprovals } from './workflow'

export default function ApprovalsWidget({ href = '/approvals' }: { href?: string }) {
  const { t } = useTranslation('approvals')
  const { data } = usePendingApprovals()
  const summary = data?.summary
  if (!summary || summary.actionable + summary.readOnly === 0) return null
  const first = (data?.data ?? []).slice(0, 5)

  return (
    <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b">
        <h2 className="font-semibold flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-primary" />
          {t('widget.title')}
        </h2>
        <Link to={href} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          {t('widget.viewAll')} <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="grid grid-cols-3 divide-x border-b text-center">
        <div className="p-3">
          <p className="text-xl font-bold text-primary">{summary.actionable}</p>
          <p className="text-[11px] text-muted-foreground">{t('summary.actionable')}</p>
        </div>
        <div className="p-3">
          <p className={`text-xl font-bold ${summary.overdue > 0 ? 'text-red-600' : ''}`}>{summary.overdue}</p>
          <p className="text-[11px] text-muted-foreground">{t('summary.overdue')}</p>
        </div>
        <div className="p-3">
          <p className={`text-xl font-bold ${summary.dueSoon > 0 ? 'text-amber-600' : ''}`}>{summary.dueSoon}</p>
          <p className="text-[11px] text-muted-foreground">{t('summary.dueSoon')}</p>
        </div>
      </div>
      <ul className="divide-y">
        {first.map(item => (
          <li key={`${item.module}:${item.id}`} className="flex items-start justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{item.employeeName}</p>
              <p className="text-xs text-muted-foreground truncate">{t(`modules.${item.module}`)} · {item.label}</p>
              <WorkflowStep workflow={item.workflow} />
            </div>
            <div className="shrink-0 text-right">
              <SlaBadge workflow={item.workflow} dueSoon={item.dueSoon} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
