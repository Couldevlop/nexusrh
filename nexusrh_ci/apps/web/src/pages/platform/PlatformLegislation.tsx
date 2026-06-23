import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { Scale, CheckCircle2, XCircle, Clock, ShieldCheck, AlertTriangle, RefreshCw } from 'lucide-react'

interface PackRow {
  code: string; countryCode: string; name: string; currency: string
  status: 'active' | 'stub'; codeStatus: 'active' | 'stub'
  smigMensuel: number; labelCaisseSociale: string; labelImpotSalaire: string
  hasOverride: boolean; lastVerifiedAt: string | null; pendingProposals: number
}
interface Proposal {
  id: string; country_code: string; summary: string
  changes: Record<string, { from?: unknown; to?: unknown }>; source: string | null; created_at: string
}

export default function PlatformLegislation() {
  const { t } = useTranslation('platform')
  const qc = useQueryClient()

  const { data: packs } = useQuery<{ data: PackRow[] }>({
    queryKey: ['platform-legislation-packs'],
    queryFn: () => api.get('/platform/legislation-packs').then(r => r.data),
  })
  const { data: proposals } = useQuery<{ data: Proposal[] }>({
    queryKey: ['platform-legislation-proposals'],
    queryFn: () => api.get('/platform/legislation-proposals', { params: { status: 'pending' } }).then(r => r.data),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['platform-legislation-packs'] })
    qc.invalidateQueries({ queryKey: ['platform-legislation-proposals'] })
  }
  const approve = useMutation({ mutationFn: (id: string) => api.post(`/platform/legislation-proposals/${id}/approve`), onSuccess: invalidate })
  const reject = useMutation({ mutationFn: (id: string) => api.post(`/platform/legislation-proposals/${id}/reject`), onSuccess: invalidate })
  const toggleStatus = useMutation({
    mutationFn: ({ country, status }: { country: string; status: 'active' | 'stub' }) =>
      api.patch(`/platform/legislation-packs/${country}`, { statusOverride: status }),
    onSuccess: invalidate,
  })

  const rows = packs?.data ?? []
  const pending = proposals?.data ?? []
  const fmt = (n: number) => new Intl.NumberFormat('fr-FR').format(n)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-2">
        <Scale className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">{t('legislation.title', 'Référentiel paie par pays')}</h1>
          <p className="text-sm text-muted-foreground">{t('legislation.subtitle', 'Packs législatifs (cotisations, impôt, SMIG, congés). Le code est la référence ; vos surcharges et les propositions de la veille hebdomadaire se valident ici.')}</p>
        </div>
      </div>

      {/* Propositions à valider (tâche planifiée hebdomadaire) */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 flex items-center gap-2 font-semibold">
          <Clock className="h-4 w-4 text-amber-600" /> {t('legislation.pending', 'Propositions à valider')}
          {pending.length > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">{pending.length}</span>}
        </h2>
        {pending.length === 0
          ? <p className="text-sm text-muted-foreground">{t('legislation.noPending', 'Aucune proposition en attente. La veille hebdomadaire ajoutera ici les nouveautés légales détectées.')}</p>
          : (
            <ul className="space-y-2">
              {pending.map(p => (
                <li key={p.id} className="rounded-lg border border-border bg-background p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-muted px-2 py-0.5 text-xs font-semibold">{p.country_code}</span>
                        <span className="text-sm font-medium">{p.summary}</span>
                      </div>
                      {Object.keys(p.changes ?? {}).length > 0 && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {Object.entries(p.changes).map(([k, v]) => (
                            <span key={k} className="mr-3">{k}: <span className="line-through">{String(v.from ?? '—')}</span> → <strong>{String(v.to ?? '—')}</strong></span>
                          ))}
                        </div>
                      )}
                      {p.source && <a href={p.source} target="_blank" rel="noreferrer" className="text-xs text-primary underline">{t('legislation.source', 'source')}</a>}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button onClick={() => approve.mutate(p.id)} disabled={approve.isPending}
                        className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">
                        <CheckCircle2 className="h-3.5 w-3.5" /> {t('legislation.approve', 'Valider')}
                      </button>
                      <button onClick={() => reject.mutate(p.id)} disabled={reject.isPending}
                        className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">
                        <XCircle className="h-3.5 w-3.5" /> {t('legislation.reject', 'Rejeter')}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </div>

      {/* Catalogue des packs pays */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2">{t('legislation.country', 'Pays')}</th>
                <th className="px-4 py-2">{t('legislation.caisse', 'Caisse')}</th>
                <th className="px-4 py-2">{t('legislation.tax', 'Impôt')}</th>
                <th className="px-4 py-2 text-right">SMIG</th>
                <th className="px-4 py-2">{t('legislation.status', 'Statut')}</th>
                <th className="px-4 py-2 text-right">{t('legislation.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.code} className="border-t border-border">
                  <td className="px-4 py-2">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground">{r.code} · {r.currency}{r.hasOverride ? ' · surchargé' : ''}{r.pendingProposals > 0 ? ` · ${r.pendingProposals} en attente` : ''}</div>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{r.labelCaisseSociale}</td>
                  <td className="px-4 py-2 text-muted-foreground">{r.labelImpotSalaire}</td>
                  <td className="px-4 py-2 text-right font-mono">{fmt(r.smigMensuel)}</td>
                  <td className="px-4 py-2">
                    {r.status === 'active'
                      ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800"><ShieldCheck className="h-3 w-3" /> {t('legislation.active', 'Actif')}</span>
                      : <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"><AlertTriangle className="h-3 w-3" /> {t('legislation.stub', 'À valider')}</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {r.codeStatus !== 'active' && (
                      r.status === 'active'
                        ? <button onClick={() => toggleStatus.mutate({ country: r.countryCode, status: 'stub' })} disabled={toggleStatus.isPending}
                            className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50">{t('legislation.deactivate', 'Désactiver')}</button>
                        : <button onClick={() => toggleStatus.mutate({ country: r.countryCode, status: 'active' })} disabled={toggleStatus.isPending}
                            title={t('legislation.activateHint', 'Activer après validation expert local')}
                            className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{t('legislation.activate', 'Activer')}</button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground"><RefreshCw className="mx-auto mb-2 h-5 w-5 animate-spin" /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('legislation.footer', 'Source de vérité : docs/referentiel-paie-afrique.md. L\'activation d\'un pack nécessite l\'implémentation des règles fines du pays (quotient familial, santé, surtaxes) et une validation par un expert paie local.')}
      </p>
    </div>
  )
}
