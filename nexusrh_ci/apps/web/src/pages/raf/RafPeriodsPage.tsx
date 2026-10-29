import { Fragment, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import { api, formatFCFA } from '@/lib/api'
import { CheckCircle2, ClipboardList, Building2, ChevronDown, ChevronRight } from 'lucide-react'
import RafVariablesSheet from './RafVariablesSheet'

/**
 * Page RAF site — chaque RAF voit UNIQUEMENT les périodes qui lui sont
 * assignées (raf_user_id = user.sub, filtre appliqué côté API).
 *
 * Workflow attendu :
 *   1. La RH centrale crée la période parente + décline aux sites
 *      (legal_entities.raf_user_id auto-assigne le RAF)
 *   2. Le RAF voit ici sa période (status = sent_to_sites) — uniquement les
 *      périodes-FILLES dont il est le RAF (`?scope=raf`), jamais la période
 *      mère du groupe, même pour un admin / hr_manager désigné RAF
 *   3. Il ouvre la feuille de la période : saisit les variables locales (heures
 *      supp, primes, absences injustifiées) et valide chaque ligne ; les
 *      dossiers salariés incomplets sont listés (contrôle obligatoire)
 *   4. Quand tout est prêt → « Soumettre » (désactivé sinon) → API génère les bulletins
 *      via calculatePayrollCI (pack législatif filiale appliqué)
 *      → status passe à completed_by_site
 *   5. La RH centrale consolide → validated_central → closed
 */

interface RafPeriod {
  id: string
  month: string
  status: string
  legal_entity_id: string | null
  legislation_pack_code: string | null
  parent_period_id: string | null
  total_gross: string | null
  total_net: string | null
  completed_by_site_at: string | null
}

const STATUS_COLOR: Record<string, string> = {
  sent_to_sites:     'bg-amber-100 text-amber-800 border-amber-200',
  completed_by_site: 'bg-blue-100 text-blue-800 border-blue-200',
  validated_central: 'bg-green-100 text-green-800 border-green-200',
  closed:            'bg-gray-100 text-gray-800 border-gray-200',
}

export default function RafPeriodsPage() {
  const { t } = useTranslation('raf')
  const qc = useQueryClient()

  const [openId, setOpenId] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery<{ data: RafPeriod[] }>({
    queryKey: ['raf-periods'],
    queryFn: () => api.get('/payroll-workflow/periods', { params: { scope: 'raf' } }).then(r => r.data),
  })

  // Charge les filiales pour résoudre nom → legal_entity_id (un RAF peut avoir
  // accès à 1 filiale, mais on prévoit l'extensibilité multi-filiales/RAF).
  const { data: entitiesData } = useQuery<{ data: Array<{ id: string; name: string; city?: string | null; cnps_number?: string | null }> }>({
    queryKey: ['raf-legal-entities'],
    queryFn: () => api.get('/settings/legal-entities').then(r => r.data),
  })
  const entityMap = new Map((entitiesData?.data ?? []).map(e => [e.id, e]))

  // Défense en profondeur : seules les périodes-filles (jamais la mère du groupe)
  const periods = (data?.data ?? []).filter(p => p.parent_period_id && p.legal_entity_id)
  const toSubmit = periods.filter(p => p.status === 'sent_to_sites')
  const loadError = (error as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ClipboardList className="h-6 w-6" /> {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t('subtitle')}
        </p>
      </div>

      {toSubmit.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <Trans i18nKey="pendingBanner" ns="raf" count={toSubmit.length} components={{ strong: <strong /> }} />
        </div>
      )}

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th className="px-4 py-3 font-semibold">{t('colMonth')}</th>
              <th className="px-4 py-3 font-semibold">{t('colSubsidiary')}</th>
              <th className="px-4 py-3 font-semibold">{t('colPack')}</th>
              <th className="px-4 py-3 font-semibold">{t('colStatus')}</th>
              <th className="px-4 py-3 font-semibold text-right">{t('colGross')}</th>
              <th className="px-4 py-3 font-semibold text-right">{t('colNet')}</th>
              <th className="px-4 py-3 font-semibold text-right">{t('colAction')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">{t('loading')}</td></tr>
            )}
            {!isLoading && periods.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                {t('empty')}
              </td></tr>
            )}
            {!isLoading && error && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-destructive">
                {typeof loadError === 'string' && loadError ? loadError : t('loadError')}
              </td></tr>
            )}
            {periods.map(p => {
              const meta = {
                label: STATUS_COLOR[p.status] ? t(`statuses.${p.status}`) : p.status,
                color: STATUS_COLOR[p.status] ?? 'bg-muted text-foreground',
              }
              const entity = p.legal_entity_id ? entityMap.get(p.legal_entity_id) : null
              const open = openId === p.id
              return (
                <Fragment key={p.id}>
                <tr className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{p.month}</td>
                  <td className="px-4 py-3">
                    {entity ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                        {entity.name}
                        {entity.cnps_number && (
                          <span className="text-xs text-muted-foreground">{t('cnpsLabel', { number: entity.cnps_number })}</span>
                        )}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono">{p.legislation_pack_code ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${meta.color}`}>
                      {p.status === 'completed_by_site' && <CheckCircle2 className="h-3 w-3" />}
                      {meta.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {p.total_gross ? formatFCFA(parseInt(p.total_gross)) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {p.total_net ? formatFCFA(parseInt(p.total_net)) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setOpenId(open ? null : p.id)}
                      aria-expanded={open}
                      className={p.status === 'sent_to_sites'
                        ? 'inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90'
                        : 'inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted'}
                    >
                      {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {p.status === 'sent_to_sites' ? t('prepare') : t('viewSheet')}
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr className="bg-muted/10">
                    <td colSpan={7} className="p-0">
                      <RafVariablesSheet
                        periodId={p.id}
                        onSubmitted={() => { setOpenId(null); qc.invalidateQueries({ queryKey: ['raf-periods'] }) }}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
