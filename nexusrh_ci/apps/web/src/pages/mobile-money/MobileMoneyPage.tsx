import { useQuery, useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { api, formatFCFA, formatMonth } from '@/lib/api'
import { Smartphone, Loader2, Send, ArrowLeftRight, Landmark, Download, CheckCircle2, AlertCircle } from 'lucide-react'

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
  const { t } = useTranslation('mobileMoney')
  const [month, setMonth] = useState('')
  const [campaignResult, setCampaignResult] = useState<CampaignResult | null>(null)
  const [paymentTab, setPaymentTab] = useState<'mobile_money' | 'bank_transfer'>('mobile_money')
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
        <h1 className="text-2xl font-bold">{t('page.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t('page.subtitle')}</p>
      </div>

      {/* Onglets : Mobile Money | Virement bancaire */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/40 p-0.5 w-fit">
        <button onClick={() => setPaymentTab('mobile_money')}
          className={`rounded-md px-4 py-1.5 text-sm font-medium ${paymentTab === 'mobile_money' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}>
          {t('tabs.mobileMoney', 'Mobile Money')}
        </button>
        <button onClick={() => setPaymentTab('bank_transfer')}
          className={`rounded-md px-4 py-1.5 text-sm font-medium ${paymentTab === 'bank_transfer' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}>
          {t('tabs.bankTransfer', 'Virement bancaire')}
        </button>
      </div>

      {paymentTab === 'bank_transfer' && <BankTransferSection />}

      {paymentTab === 'mobile_money' && (<>
      {/* Créer une campagne */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-4 flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4" /> {t('campaign.newTitle')}
        </h2>
        <div className="flex items-end gap-3">
          <div>
            <label className="text-sm font-medium mb-1 block">{t('campaign.payMonth')}</label>
            <select value={month} onChange={e => setMonth(e.target.value)}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
              <option value="">{t('campaign.selectMonth')}</option>
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
            {t('campaign.prepare')}
          </button>
        </div>

        {campaignMut.isError && (
          <p className="mt-2 text-sm text-destructive">
            {(campaignMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('campaign.networkError')}
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
                <Trans i18nKey="campaign.goToPayrollHint" ns="mobileMoney" components={{ strong: <strong /> }} />
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
            {t('campaign.readyTitle', { count: campaignResult.paySlips.length })}
          </h3>
          <p className="text-sm text-blue-700 mb-4">
            {t('campaign.total')}<strong>{formatFCFA(campaignResult.paySlips.reduce((s, p) => s + p.amount, 0))}</strong>
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
                {t('campaign.moreOthers', { count: campaignResult.paySlips.length - 10 })}
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
              {t('campaign.execute')}
            </button>
            <button onClick={() => setCampaignResult(null)}
              className="rounded-lg border border-blue-200 px-4 py-2 text-sm text-blue-700 hover:bg-blue-100">
              {t('campaign.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Historique */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-6 py-4">
          <h2 className="font-semibold">{t('history.title')}</h2>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="p-4">{t('history.employee')}</th>
                <th className="p-4">{t('history.period')}</th>
                <th className="p-4">{t('history.providerNumber')}</th>
                <th className="p-4 text-right">{t('history.amount')}</th>
                <th className="p-4">{t('history.status')}</th>
                <th className="p-4">{t('history.reference')}</th>
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
                      {p.status === 'completed' ? t('status.completed') : p.status === 'failed' ? t('status.failed') : t('status.pending')}
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
                    {t('history.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      </>)}
    </div>
  )
}

interface BankPreview { bank: string; count: number; total: number; email: string }
interface SendResult { success: boolean; message: string; results?: Array<{ bank: string; count: number; total: number; sent: boolean; error?: string }> }

// Virement bancaire — sélection période + banques, génération du fichier Excel
// par banque, envoi par email (expéditeur = config du tenant) et confirmation.
function BankTransferSection() {
  const { t } = useTranslation('mobileMoney')
  const [month, setMonth] = useState('')
  const [emails, setEmails] = useState<Record<string, string>>({})
  const [unselected, setUnselected] = useState<Record<string, boolean>>({})
  const [result, setResult] = useState<SendResult | null>(null)

  const { data, isFetching } = useQuery<{ data: BankPreview[] }>({
    queryKey: ['bank-transfer-preview', month],
    queryFn: () => api.get(`/bank-transfer/preview?month=${month}`).then(r => r.data),
    enabled: /^\d{4}-\d{2}$/.test(month),
  })
  const banks = data?.data ?? []
  const emailOf = (b: BankPreview) => emails[b.bank] ?? b.email ?? ''
  const isSelected = (b: BankPreview) => !unselected[b.bank]

  const sendMut = useMutation({
    mutationFn: () => {
      const payload = banks.filter(isSelected).map(b => ({ name: b.bank, email: emailOf(b).trim() }))
      return api.post('/bank-transfer/send', { month, banks: payload }).then(r => r.data as SendResult)
    },
    onSuccess: (res) => setResult(res),
    onError: () => setResult({ success: false, message: t('bank.sendError', 'Échec de l\'envoi — vérifiez les emails et le SMTP du tenant.') }),
  })

  const downloadFile = async (bank: string) => {
    const res = await api.get(`/bank-transfer/file?month=${month}&bank=${encodeURIComponent(bank)}`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url; a.download = `Virements_${bank.replace(/[^A-Za-z0-9]/g, '_')}_${month}.xlsx`; a.click()
    URL.revokeObjectURL(url)
  }

  const selectedBanks = banks.filter(isSelected)
  const canSend = selectedBanks.length > 0 && selectedBanks.every(b => /.+@.+\..+/.test(emailOf(b)))

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-1 flex items-center gap-2"><Landmark className="h-4 w-4" /> {t('bank.title', 'Virement bancaire des salaires')}</h2>
        <p className="text-sm text-muted-foreground mb-4">{t('bank.subtitle', 'Génère un fichier Excel par banque (bénéficiaires + RIB + montants) et l\'envoie à la banque. L\'expéditeur est l\'email paramétré par votre entreprise.')}</p>
        <div>
          <label className="text-sm font-medium mb-1 block">{t('campaign.payMonth')}</label>
          <select value={month} onChange={e => { setMonth(e.target.value); setResult(null) }}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
            <option value="">{t('campaign.selectMonth')}</option>
            {Array.from({ length: 12 }, (_, i) => {
              const d = new Date(); d.setMonth(d.getMonth() - i)
              const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
              return <option key={m} value={m}>{formatMonth(m)}</option>
            })}
          </select>
        </div>
      </div>

      {isFetching && <div className="flex items-center justify-center p-6"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>}

      {!isFetching && month && banks.length === 0 && (
        <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">{t('bank.empty', 'Aucun employé payé par virement bancaire pour cette période (vérifiez le mode de paiement + RIB des employés).')}</p>
      )}

      {banks.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="p-3 text-left w-8"></th>
                <th className="p-3 text-left">{t('bank.bank', 'Banque')}</th>
                <th className="p-3 text-center">{t('bank.count', 'Virements')}</th>
                <th className="p-3 text-right">{t('bank.total', 'Total')}</th>
                <th className="p-3 text-left">{t('bank.email', 'Email banque')}</th>
                <th className="p-3 text-center">{t('bank.file', 'Fichier')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {banks.map(b => (
                <tr key={b.bank}>
                  <td className="p-3"><input type="checkbox" checked={isSelected(b)} onChange={e => setUnselected(s => ({ ...s, [b.bank]: !e.target.checked }))} className="h-4 w-4" /></td>
                  <td className="p-3 font-medium">{b.bank}</td>
                  <td className="p-3 text-center">{b.count}</td>
                  <td className="p-3 text-right font-semibold">{formatFCFA(b.total)}</td>
                  <td className="p-3">
                    <input type="email" value={emailOf(b)} onChange={e => setEmails(s => ({ ...s, [b.bank]: e.target.value }))}
                      placeholder="banque@exemple.ci"
                      className="w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring" />
                  </td>
                  <td className="p-3 text-center">
                    <button onClick={() => void downloadFile(b.bank)} title={t('bank.download', 'Télécharger l\'Excel')}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-primary/10 hover:text-primary"><Download className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">{t('bank.selectedCount', { count: selectedBanks.length, defaultValue: '{{count}} banque(s) sélectionnée(s)' })}</span>
            <button onClick={() => sendMut.mutate()} disabled={!canSend || sendMut.isPending}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {sendMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {t('bank.generateSend', 'Générer et envoyer')}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${result.success ? 'border-green-200 bg-green-50 text-green-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
          {result.success ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" /> : <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />}
          <div>
            <p className="font-medium">{result.message}</p>
            {result.results && (
              <ul className="mt-1 text-xs">
                {result.results.map(r => (
                  <li key={r.bank}>{r.bank} — {r.sent ? t('bank.ok', 'envoyé') : `${t('bank.failed', 'échec')}${r.error ? ` (${r.error})` : ''}`} · {r.count} virement(s)</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
