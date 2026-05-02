import { useQuery, useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api, formatFCFA, formatMonth } from '@/lib/api'
import { Smartphone, Loader2, Send, ArrowLeftRight } from 'lucide-react'

interface PaymentRecord {
  id: string; provider: string; phone: string; amount: string
  status: string; transaction_id: string | null; error_message: string | null
  first_name: string; last_name: string; month: string
  created_at: string
}

interface CampaignPaySlip {
  paySlipId: string; name: string; amount: number; provider: string; phone: string
}

interface CampaignResult {
  reference: string | null
  paySlips: CampaignPaySlip[]
  month: string
  employeesCount: number
  totalAmount: number
  currency: string
  allPaid?: boolean
  message?: string
}

const PROVIDER_LABEL: Record<string, string> = {
  wave: 'Wave', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money',
}
const PROVIDER_COLOR: Record<string, string> = {
  wave: 'bg-blue-100 text-blue-700',
  mtn_momo: 'bg-yellow-100 text-yellow-700',
  orange_money: 'bg-orange-100 text-orange-700',
}

export default function MobileMoneyPage() {
  const [month, setMonth] = useState('')
  const [campaignResult, setCampaignResult] = useState<CampaignResult | null>(null)
  const { data: paymentsData, isLoading, refetch } = useQuery<{ data: PaymentRecord[] }>({
    queryKey: ['mm-payments', month],
    queryFn: () => api.get(`/mobile-money/payments${month ? `?month=${month}` : ''}`).then(r => r.data),
  })

  const campaignMut = useMutation({
    mutationFn: (m: string) => api.post<CampaignResult>('/mobile-money/campaigns', { month: m }),
    onSuccess: (res) => setCampaignResult(res.data),
  })

  const executeMut = useMutation({
    mutationFn: (params: { reference: string; paySlipIds: string[] }) =>
      api.post(`/mobile-money/campaigns/${params.reference}/execute`, { paySlipIds: params.paySlipIds }),
    onSuccess: () => {
      setCampaignResult(null)
      refetch()
    },
  })

  const payments = paymentsData?.data ?? []

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Mobile Money — Virements salaires</h1>
        <p className="text-sm text-muted-foreground mt-1">Wave · MTN MoMo · Orange Money CI</p>
      </div>

      {/* Créer une campagne */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-4 flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4" /> Nouvelle campagne de virement
        </h2>
        <div className="flex items-end gap-3">
          <div>
            <label className="text-sm font-medium mb-1 block">Mois de paie</label>
            <select value={month} onChange={e => setMonth(e.target.value)}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
              <option value="">-- Sélectionner --</option>
              {Array.from({ length: 12 }, (_, i) => {
                const d = new Date()
                d.setMonth(d.getMonth() - i)
                const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
                return <option key={m} value={m}>{formatMonth(m)}</option>
              })}
            </select>
          </div>
          <button
            onClick={() => month && campaignMut.mutate(month)}
            disabled={!month || campaignMut.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {campaignMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Préparer la campagne
          </button>
        </div>

        {campaignMut.isError && (
          <p className="mt-2 text-sm text-destructive">
            {(campaignMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Erreur réseau'}
          </p>
        )}
      </div>

      {/* Résultat campagne : aucun bulletin / déjà payé */}
      {campaignResult && campaignResult.paySlips.length === 0 && (
        <div className={`rounded-xl border p-4 flex items-start gap-3 ${campaignResult.allPaid ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
          <span className="text-xl">{campaignResult.allPaid ? '✅' : '⚠️'}</span>
          <div>
            <p className={`text-sm font-medium ${campaignResult.allPaid ? 'text-green-800' : 'text-amber-800'}`}>
              {campaignResult.message}
            </p>
            {!campaignResult.allPaid && (
              <p className="text-xs text-amber-600 mt-1">
                Allez dans <strong>Paie → Clôturer une période</strong> pour ce mois, puis revenez.
              </p>
            )}
          </div>
          <button onClick={() => setCampaignResult(null)} className="ml-auto text-muted-foreground hover:text-foreground text-xs">✕</button>
        </div>
      )}

      {/* Campagne prête avec bulletins */}
      {campaignResult && campaignResult.paySlips.length > 0 && campaignResult.reference && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-6">
          <h3 className="font-semibold text-blue-800 mb-3">
            Campagne prête — {campaignResult.paySlips.length} virements
          </h3>
          <p className="text-sm text-blue-700 mb-4">
            Total : <strong>{formatFCFA(campaignResult.paySlips.reduce((s, p) => s + p.amount, 0))}</strong>
          </p>
          <div className="max-h-48 overflow-auto mb-4 space-y-1">
            {campaignResult.paySlips.slice(0, 10).map(s => (
              <div key={s.paySlipId} className="flex items-center justify-between text-sm bg-white rounded px-3 py-1.5">
                <span>{s.name}</span>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PROVIDER_COLOR[s.provider] ?? 'bg-muted'}`}>
                    {PROVIDER_LABEL[s.provider] ?? s.provider}
                  </span>
                  <span className="font-mono text-xs">{formatFCFA(s.amount)}</span>
                </div>
              </div>
            ))}
            {campaignResult.paySlips.length > 10 && (
              <p className="text-xs text-muted-foreground text-center">
                + {campaignResult.paySlips.length - 10} autres...
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => executeMut.mutate({
                reference: campaignResult.reference!,
                paySlipIds: campaignResult.paySlips.map(p => p.paySlipId),
              })}
              disabled={executeMut.isPending}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {executeMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              <Send className="h-4 w-4" />
              Lancer les virements
            </button>
            <button onClick={() => setCampaignResult(null)}
              className="rounded-lg border border-blue-200 px-4 py-2 text-sm text-blue-700 hover:bg-blue-100">
              Annuler
            </button>
          </div>
        </div>
      )}

      {/* Historique */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-6 py-4">
          <h2 className="font-semibold">Historique des paiements</h2>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="p-4">Employé</th>
                <th className="p-4">Période</th>
                <th className="p-4">Opérateur · Numéro</th>
                <th className="p-4 text-right">Montant</th>
                <th className="p-4">Statut</th>
                <th className="p-4">Référence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {payments.map(p => (
                <tr key={p.id} className="hover:bg-muted/30">
                  <td className="p-4 font-medium">{p.first_name} {p.last_name}</td>
                  <td className="p-4 text-muted-foreground capitalize">{formatMonth(p.month)}</td>
                  <td className="p-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PROVIDER_COLOR[p.provider] ?? 'bg-muted'}`}>
                      {PROVIDER_LABEL[p.provider] ?? p.provider}
                    </span>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">{p.phone}</p>
                  </td>
                  <td className="p-4 text-right font-mono font-semibold">{formatFCFA(parseInt(p.amount ?? '0'))}</td>
                  <td className="p-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      p.status === 'completed' ? 'bg-green-100 text-green-700' :
                      p.status === 'failed' ? 'bg-red-100 text-red-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>
                      {p.status === 'completed' ? 'Réussi' : p.status === 'failed' ? 'Échec' : 'En attente'}
                    </span>
                    {p.error_message && <p className="text-xs text-destructive mt-0.5 truncate max-w-[150px]">{p.error_message}</p>}
                  </td>
                  <td className="p-4 text-xs text-muted-foreground font-mono truncate max-w-[120px]">
                    {p.transaction_id ?? '—'}
                  </td>
                </tr>
              ))}
              {payments.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-muted-foreground">
                    <Smartphone className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    Aucun paiement enregistré
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
