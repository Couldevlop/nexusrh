/**
 * Alertes d'échéance des valideurs (N+1, N+2… ou équipe RH) :
 *  (a) bannière persistante en haut du contenu tant qu'il reste des validations
 *      en retard ou arrivant à échéance (< 12 h) ;
 *  (b) fenêtre de rappel listant ces demandes, affichée une fois par session de
 *      navigateur et par ensemble de demandes (« Me le rappeler plus tard » la
 *      reporte d'une heure).
 * Rien n'est rendu quand l'utilisateur n'a aucune demande urgente à traiter.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Clock, X } from 'lucide-react'
import { formatDueAt, usePendingApprovals, type PendingApproval } from './workflow'

const SEEN_KEY = 'nexusrh:approvals-reminder-seen'
const SNOOZE_KEY = 'nexusrh:approvals-reminder-snooze'
const SNOOZE_MS = 3_600_000

function readSession(key: string): string | null {
  try { return sessionStorage.getItem(key) } catch { return null }
}
function writeSession(key: string, value: string): void {
  try { sessionStorage.setItem(key, value) } catch { /* stockage inaccessible : rappel non mémorisé */ }
}

/** Le rappel est dû si cet ensemble de demandes n'a pas déjà été vu et qu'aucun report n'est en cours. */
function reminderDue(signature: string, now: number): boolean {
  if (readSession(SEEN_KEY) === signature) return false
  const snoozedUntil = Number(readSession(SNOOZE_KEY) ?? 0)
  return !(snoozedUntil > now)
}

export default function ApprovalAlerts({ href }: { href: string }) {
  const { t } = useTranslation('approvals')
  const navigate = useNavigate()
  const { data, dataUpdatedAt } = usePendingApprovals()
  const summary = data?.summary
  const urgent = useMemo<PendingApproval[]>(
    () => (data?.data ?? []).filter(i => i.workflow.canAct && (i.workflow.overdue || i.dueSoon)),
    [data],
  )
  // Signature stable de l'ensemble urgent : un nouvel élément relance le rappel.
  const signature = useMemo(() => urgent.map(i => `${i.module}:${i.id}`).sort().join('|'), [urgent])
  const [open, setOpen] = useState(false)

  // Réévalué à chaque rafraîchissement (5 min) : un report d'une heure expiré rouvre le rappel.
  useEffect(() => {
    setOpen(signature !== '' && reminderDue(signature, Date.now()))
  }, [signature, dataUpdatedAt])

  const overdue = summary?.overdue ?? 0
  const dueSoon = summary?.dueSoon ?? 0
  if (!summary || (overdue === 0 && dueSoon === 0)) return null

  const parts = [
    overdue > 0 ? t('banner.overdue', { count: overdue }) : null,
    dueSoon > 0 ? t('banner.dueSoon', { count: dueSoon }) : null,
  ].filter((p): p is string => !!p)

  const markSeen = () => { writeSession(SEEN_KEY, signature); setOpen(false) }
  const processNow = () => { markSeen(); navigate(href) }
  const remindLater = () => { writeSession(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); setOpen(false) }

  return (
    <>
      <div
        role="alert"
        data-testid="approval-alerts-banner"
        className={`flex items-center gap-3 px-4 py-2 text-sm font-medium shrink-0 ${
          overdue > 0 ? 'bg-red-600 text-white' : 'bg-amber-100 text-amber-900'
        }`}>
        {overdue > 0 ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <Clock className="h-4 w-4 shrink-0" />}
        <span className="flex-1 min-w-0 truncate">{parts.join(' · ')}</span>
        <Link to={href} className="shrink-0 rounded-md px-2 py-0.5 underline underline-offset-2 hover:opacity-80">
          {t('banner.view')}
        </Link>
      </div>

      {open && urgent.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={markSeen}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-reminder-title"
            className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl"
            onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 id="approval-reminder-title" className="font-semibold">{t('reminder.title')}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t('reminder.intro')}</p>
              </div>
              <button onClick={markSeen} aria-label={t('actions.close')}
                className="rounded-md p-1 text-muted-foreground hover:bg-accent">
                <X className="h-4 w-4" />
              </button>
            </div>
            <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {urgent.map(item => (
                <li key={`${item.module}:${item.id}`} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{item.employeeName}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {t(`modules.${item.module}`)} · {item.label}{item.detail ? ` · ${item.detail}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {item.workflow.dueAt && <p className="text-xs text-muted-foreground">{formatDueAt(item.workflow.dueAt)}</p>}
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      item.workflow.overdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                    }`}>
                      {item.workflow.overdue ? t('sla.overdue') : t('sla.dueSoon')}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button onClick={remindLater} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">
                {t('actions.remindLater')}
              </button>
              <button onClick={processNow}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
                {t('actions.processNow')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
