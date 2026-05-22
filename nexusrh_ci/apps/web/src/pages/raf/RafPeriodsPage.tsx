import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, formatFCFA } from '@/lib/api'
import { Send, Loader2, CheckCircle2, ClipboardList, Building2 } from 'lucide-react'

/**
 * Page RAF site — chaque RAF voit UNIQUEMENT les périodes qui lui sont
 * assignées (raf_user_id = user.sub, filtre appliqué côté API).
 *
 * Workflow attendu :
 *   1. La RH centrale crée la période parente + décline aux sites
 *      (legal_entities.raf_user_id auto-assigne le RAF)
 *   2. Le RAF voit ici sa période (status = sent_to_sites)
 *   3. Il saisit les variables locales (heures supp, primes, absences)
 *      dans les pages dédiées employees / payroll-variables
 *   4. Quand il a complété → clic "Soumettre" → API génère les bulletins
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

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  sent_to_sites:     { label: 'À compléter',  color: 'bg-amber-100 text-amber-800 border-amber-200' },
  completed_by_site: { label: 'Soumise',      color: 'bg-blue-100 text-blue-800 border-blue-200' },
  validated_central: { label: 'Validée',      color: 'bg-green-100 text-green-800 border-green-200' },
  closed:            { label: 'Clôturée',     color: 'bg-gray-100 text-gray-800 border-gray-200' },
}

export default function RafPeriodsPage() {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery<{ data: RafPeriod[] }>({
    queryKey: ['raf-periods'],
    queryFn: () => api.get('/payroll-workflow/periods').then(r => r.data),
  })

  // Charge les filiales pour résoudre nom → legal_entity_id (un RAF peut avoir
  // accès à 1 filiale, mais on prévoit l'extensibilité multi-filiales/RAF).
  const { data: entitiesData } = useQuery<{ data: Array<{ id: string; name: string; city?: string | null; cnps_number?: string | null }> }>({
    queryKey: ['raf-legal-entities'],
    queryFn: () => api.get('/settings/legal-entities').then(r => r.data),
  })
  const entityMap = new Map((entitiesData?.data ?? []).map(e => [e.id, e]))

  const submitMut = useMutation({
    mutationFn: (id: string) => api.post(`/payroll-workflow/periods/${id}/submit-by-raf`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['raf-periods'] }),
  })

  const periods = data?.data ?? []
  const toSubmit = periods.filter(p => p.status === 'sent_to_sites' && p.parent_period_id)

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ClipboardList className="h-6 w-6" /> Paie de ma filiale
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Périodes à compléter pour la (les) filiale(s) sous votre responsabilité.
          Saisissez les variables locales (heures supp, primes, absences) avant de soumettre.
        </p>
      </div>

      {toSubmit.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>{toSubmit.length}</strong> période{toSubmit.length > 1 ? 's' : ''} en attente de votre soumission
        </div>
      )}

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th className="px-4 py-3 font-semibold">Mois</th>
              <th className="px-4 py-3 font-semibold">Filiale</th>
              <th className="px-4 py-3 font-semibold">Pack législatif</th>
              <th className="px-4 py-3 font-semibold">Statut</th>
              <th className="px-4 py-3 font-semibold text-right">Masse brute</th>
              <th className="px-4 py-3 font-semibold text-right">Net à payer</th>
              <th className="px-4 py-3 font-semibold text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">Chargement…</td></tr>
            )}
            {!isLoading && periods.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                Aucune période en attente. La RH centrale n'a pas encore initié la paie du mois ou ne vous a pas assigné de filiale.
              </td></tr>
            )}
            {periods.map(p => {
              const meta = STATUS_LABEL[p.status] ?? { label: p.status, color: 'bg-muted text-foreground' }
              const entity = p.legal_entity_id ? entityMap.get(p.legal_entity_id) : null
              return (
                <tr key={p.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{p.month}</td>
                  <td className="px-4 py-3">
                    {entity ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                        {entity.name}
                        {entity.cnps_number && (
                          <span className="text-xs text-muted-foreground">· CNPS {entity.cnps_number}</span>
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
                    {p.status === 'sent_to_sites' ? (
                      <button
                        onClick={() => {
                          if (confirm(`Soumettre la paie ${p.month} ? Les bulletins seront générés et le brouillon transmis à la direction centrale.`)) {
                            submitMut.mutate(p.id)
                          }
                        }}
                        disabled={submitMut.isPending}
                        className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                      >
                        {submitMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                        Soumettre
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {submitMut.isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {(submitMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Erreur lors de la soumission'}
        </div>
      )}
    </div>
  )
}
