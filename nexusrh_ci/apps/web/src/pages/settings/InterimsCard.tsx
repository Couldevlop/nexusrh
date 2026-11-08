/**
 * Intérims de validation — carte de l'onglet Paramètres → Workflow.
 *
 * L'écran part des CONGÉS, pas des intérims : la première liste montre les
 * absences à venir des personnes qui portent une étape de validation, celles
 * sans suppléant d'abord. C'est la question posée par la direction — « qui
 * valide pendant les congés de l'équipe RH ? » — et la réponse se lit d'un
 * coup d'œil, avant que le circuit ne s'arrête.
 *
 * Désigner un suppléant depuis une ligne de congé n'exige AUCUNE saisie de
 * date : le serveur reprend celles du congé. C'est ce qui distingue l'intérim
 * d'une délégation d'habilitation, qu'on borne à la main.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CalendarClock, ShieldCheck, Trash2, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'

interface CoverageRow {
  absenceId: string; startDate: string; endDate: string; status: string
  userId: string; role: string; name: string; covered: boolean
}
interface InterimRow {
  id: string; absentUserId: string; interimUserId: string
  absentName: string | null; interimName: string | null
  absentRole: string | null; interimRole: string | null
  startsAt: string; endsAt: string; reason: string | null
  revokedAt: string | null; active: boolean
  absenceId: string | null; source: 'absence' | 'manual'
}
interface UserOption { id: string; first_name: string; last_name: string; role: string; is_active: boolean }

const DAY = 'numeric' as const
function day(iso: string, locale: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale, { day: DAY, month: 'short', year: 'numeric' })
}

export default function InterimsCard() {
  const { t, i18n } = useTranslation('settings')
  const qc = useQueryClient()
  // `i18n` peut manquer quand un banc voisin ne mocke que `t` : le format de
  // date n'est pas une raison de faire tomber l'onglet entier.
  const locale = i18n?.language?.startsWith('en') ? 'en-GB' : 'fr-FR'
  /** Ligne de congé en cours de désignation → suppléant choisi. */
  const [designating, setDesignating] = useState<CoverageRow | null>(null)
  const [standIn, setStandIn] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: coverageData } = useQuery<{ data: CoverageRow[] }>({
    queryKey: ['settings-interims-coverage'],
    queryFn: () => api.get<{ data: CoverageRow[] }>('/settings/interims/coverage').then(r => r.data),
  })
  const { data: interimsData } = useQuery<{ data: InterimRow[] }>({
    queryKey: ['settings-interims'],
    queryFn: () => api.get<{ data: InterimRow[] }>('/settings/interims').then(r => r.data),
  })
  const { data: usersData } = useQuery<{ data: UserOption[] }>({
    queryKey: ['settings-users'],
    queryFn: () => api.get<{ data: UserOption[] }>('/settings/users').then(r => r.data),
  })

  const coverage = coverageData?.data ?? []
  const interims = interimsData?.data ?? []
  const uncovered = coverage.filter(c => !c.covered)

  function refresh() {
    qc.invalidateQueries({ queryKey: ['settings-interims'] })
    qc.invalidateQueries({ queryKey: ['settings-interims-coverage'] })
  }

  const declare = useMutation({
    mutationFn: (payload: { absentUserId: string; interimUserId: string; absenceId: string }) =>
      api.post('/settings/interims', payload),
    onSuccess: () => { setDesignating(null); setStandIn(''); setError(null); refresh() },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } }).response?.data?.error
      setError(msg ?? t('workflow.interims.declareError'))
    },
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/interims/${id}`),
    onSuccess: refresh,
  })

  // Suppléant possible : un autre compte actif, jamais la personne remplacée.
  const candidates = (usersData?.data ?? [])
    .filter(u => u.is_active && u.id !== designating?.userId)

  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-4">
      <div>
        <h2 className="flex items-center gap-2 font-semibold">
          <CalendarClock className="h-4 w-4" /> {t('workflow.interims.title')}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('workflow.interims.description')}</p>
      </div>

      {/* Congés de valideurs — non couverts d'abord : ce sont les circuits qui vont s'arrêter. */}
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('workflow.interims.coverageTitle')}</p>
        {coverage.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('workflow.interims.noLeave')}</p>
        )}
        {uncovered.length > 0 && (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {t('workflow.interims.uncoveredWarning', { count: uncovered.length })}
          </div>
        )}
        {coverage.map(row => (
          <div key={row.absenceId} className="rounded-lg border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">{row.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {t(`workflow.interims.roles.${row.role}`, { defaultValue: row.role })}
                </span>
                <p className="text-xs text-muted-foreground">
                  {day(row.startDate, locale)} → {day(row.endDate, locale)}
                  {row.status === 'pending' && ` · ${t('workflow.interims.leavePending')}`}
                </p>
              </div>
              {row.covered ? (
                <span className="flex items-center gap-1 text-xs text-green-600">
                  <ShieldCheck className="h-3.5 w-3.5" /> {t('workflow.interims.covered')}
                </span>
              ) : (
                <button
                  onClick={() => { setDesignating(row); setStandIn(''); setError(null) }}
                  className="rounded-lg border border-input px-3 py-1 text-xs font-medium hover:bg-accent">
                  {t('workflow.interims.designate')}
                </button>
              )}
            </div>

            {designating?.absenceId === row.absenceId && (
              <div className="mt-3 space-y-2 rounded-lg bg-muted/30 p-3">
                {/* Aucune date à saisir : le serveur reprend celles du congé. */}
                <p className="text-xs text-muted-foreground">
                  {t('workflow.interims.datesFromLeave', {
                    start: day(row.startDate, locale), end: day(row.endDate, locale),
                  })}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs" htmlFor="interim-stand-in">
                    {t('workflow.interims.standIn')}
                  </label>
                  <select
                    id="interim-stand-in" value={standIn} onChange={e => setStandIn(e.target.value)}
                    className="rounded-lg border border-input bg-background px-2 py-1 text-sm">
                    <option value="">{t('workflow.interims.choose')}</option>
                    {candidates.map(u => (
                      <option key={u.id} value={u.id}>
                        {u.first_name} {u.last_name} — {t(`workflow.interims.roles.${u.role}`, { defaultValue: u.role })}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={!standIn || declare.isPending}
                    onClick={() => declare.mutate({
                      absentUserId: row.userId, interimUserId: standIn, absenceId: row.absenceId,
                    })}
                    className="rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                    {declare.isPending ? t('workflow.interims.declaring') : t('workflow.interims.declare')}
                  </button>
                  <button onClick={() => { setDesignating(null); setError(null) }}
                    className="text-xs text-muted-foreground hover:underline">
                    {t('workflow.interims.cancel')}
                  </button>
                </div>
                {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Suppléances enregistrées : qui décide à la place de qui, et jusqu'à quand. */}
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('workflow.interims.listTitle')}</p>
        {interims.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('workflow.interims.none')}</p>
        )}
        {interims.map(row => (
          <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
            <div>
              <p>
                <span className="font-medium">{row.interimName ?? '—'}</span>
                <span className="text-muted-foreground"> {t('workflow.interims.replaces')} </span>
                <span className="font-medium">{row.absentName ?? '—'}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {day(row.startsAt, locale)} → {day(row.endsAt, locale)}
                {' · '}
                {t(row.source === 'absence' ? 'workflow.interims.sourceLeave' : 'workflow.interims.sourceManual')}
                {row.reason ? ` · ${row.reason}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {row.active
                ? <span className="text-xs text-green-600">{t('workflow.interims.active')}</span>
                : <span className="text-xs text-muted-foreground">
                    {row.revokedAt ? t('workflow.interims.revoked') : t('workflow.interims.ended')}
                  </span>}
              {row.active && (
                <button
                  onClick={() => revoke.mutate(row.id)} disabled={revoke.isPending}
                  aria-label={t('workflow.interims.revokeAction')}
                  className="flex items-center gap-1 rounded-lg border border-input px-2 py-1 text-xs hover:bg-accent disabled:opacity-50">
                  <Trash2 className="h-3.5 w-3.5" /> {t('workflow.interims.revokeAction')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
