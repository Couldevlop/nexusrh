import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api, formatFCFA, formatMonth } from '@/lib/api'
import { FileText, Download, Eye, X, ChevronDown, ChevronUp, Calculator } from 'lucide-react'
import PaySlipTransparentModal from '@/components/payroll/PaySlipTransparentModal'

interface PaySlip {
  id: string; month: string
  gross_salary: string; net_payable: string; its: string; total_cnps_sal: string
  status: string; payment_method: string; payment_status: string
  payment_reference: string | null; generated_at: string
  viewed_by_employee_at: string | null; currency: string
}

const PROVIDER_LABEL: Record<string, string> = {
  wave: 'Wave', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money',
}

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4001'

function getPdfUrl(id: string) {
  return `${API_BASE}/payroll/my-payslips/${id}/pdf`
}

function PdfViewer({ slipId, onClose }: { slipId: string; onClose: () => void }) {
  const { t } = useTranslation('monEspace')
  const [loading, setLoading] = useState(true)
  const token = localStorage.getItem('token') ?? ''
  const src = `${getPdfUrl(slipId)}?token=${encodeURIComponent(token)}`

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/60 backdrop-blur-sm">
      <div className="flex items-center justify-between bg-background px-4 py-3 border-b border-border shadow">
        <p className="font-semibold text-sm">{t('payslips.previewTitle')}</p>
        <div className="flex items-center gap-2">
          <a
            href={src}
            download={`bulletin_${slipId}.pdf`}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            <Download className="h-3.5 w-3.5" /> {t('payslips.downloadPdf')}
          </a>
          <button onClick={onClose} className="rounded-lg border border-border bg-background p-1.5 hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <div className="h-7 w-7 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        )}
        <iframe
          src={src}
          title={t('payslips.payslipPdf')}
          className="w-full h-full"
          onLoad={() => setLoading(false)}
        />
      </div>
    </div>
  )
}

export default function MesBulletins() {
  const { t } = useTranslation('monEspace')
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [explainId, setExplainId] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: PaySlip[]; currency: string }>({
    queryKey: ['my-payslips'],
    queryFn: () => api.get('/payroll/my-payslips').then(r => r.data),
  })

  const slips = data?.data ?? []
  const token = localStorage.getItem('token') ?? ''

  return (
    <>
      {viewingId && <PdfViewer slipId={viewingId} onClose={() => setViewingId(null)} />}
      {explainId && <PaySlipTransparentModal slipId={explainId} onClose={() => setExplainId(null)} />}

      <div className="p-6 space-y-6">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold">{t('payslips.title')}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t('payslips.subtitle', { count: slips.length })}
            </p>
          </div>
          {slips.some(s => !s.viewed_by_employee_at) && (
            <span className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
              {t('payslips.newBadge', { count: slips.filter(s => !s.viewed_by_employee_at).length })}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center p-16">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="space-y-2">
            {slips.map(slip => {
              const expanded = expandedId === slip.id
              const pdfSrc = `${getPdfUrl(slip.id)}?token=${encodeURIComponent(token)}`
              return (
                <div key={slip.id} className="rounded-xl border border-border bg-card overflow-hidden hover:shadow-sm transition-shadow">
                  {/* Ligne principale */}
                  <div className="flex items-center gap-4 px-5 py-4">
                    {/* Icône */}
                    <div className="rounded-lg bg-primary/10 p-2.5 shrink-0">
                      <FileText className="h-5 w-5 text-primary" />
                    </div>

                    {/* Mois + badges */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold capitalize">{formatMonth(slip.month)}</p>
                        {!slip.viewed_by_employee_at && (
                          <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                            {t('payslips.newTag')}
                          </span>
                        )}
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          slip.payment_status === 'paid'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-amber-100 text-amber-700'
                        }`}>
                          {slip.payment_status === 'paid' ? t('payslips.paid') : t('payslips.pending')}
                        </span>
                      </div>
                      {slip.payment_method && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {PROVIDER_LABEL[slip.payment_method] ?? (slip.payment_method === 'bank_transfer' ? t('payslips.providers.bankTransfer') : slip.payment_method)}
                          {slip.payment_reference && (
                            <span className="font-mono ml-1">· {slip.payment_reference}</span>
                          )}
                        </p>
                      )}
                    </div>

                    {/* Net à payer */}
                    <div className="text-right shrink-0">
                      <p className="text-lg font-bold text-primary leading-tight">
                        {formatFCFA(parseInt(slip.net_payable ?? '0'))}
                      </p>
                      <p className="text-[10px] text-muted-foreground">{t('payslips.netPayable')}</p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => setExplainId(slip.id)}
                        title={t('payslips.understandTooltip')}
                        className="flex items-center gap-1 rounded-lg border border-primary/40 bg-primary/5 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
                      >
                        <Calculator className="h-3.5 w-3.5" /> {t('payslips.understand')}
                      </button>
                      <button
                        onClick={() => setViewingId(slip.id)}
                        title={t('payslips.viewTooltip')}
                        className="flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
                      >
                        <Eye className="h-3.5 w-3.5" /> {t('payslips.view')}
                      </button>
                      <a
                        href={pdfSrc}
                        download={`bulletin_${slip.month}.pdf`}
                        title={t('payslips.pdfTooltip')}
                        className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
                      >
                        <Download className="h-3.5 w-3.5" /> {t('payslips.pdf')}
                      </a>
                      <button
                        onClick={() => setExpandedId(expanded ? null : slip.id)}
                        className="rounded-lg border border-border bg-background p-1.5 hover:bg-accent transition-colors"
                      >
                        {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>

                  {/* Détails dépliables */}
                  {expanded && (
                    <div className="border-t border-border bg-muted/30 px-5 py-4 grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
                      <div>
                        <p className="text-xs text-muted-foreground">{t('payslips.grossSalary')}</p>
                        <p className="font-semibold">{formatFCFA(parseInt(slip.gross_salary ?? '0'))}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t('payslips.cnpsEmployee')}</p>
                        <p className="font-semibold text-orange-600">{formatFCFA(parseInt(slip.total_cnps_sal ?? '0'))}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t('payslips.itsWithheld')}</p>
                        <p className="font-semibold text-blue-600">{formatFCFA(parseInt(slip.its ?? '0'))}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t('payslips.netPayable')}</p>
                        <p className="font-bold text-primary">{formatFCFA(parseInt(slip.net_payable ?? '0'))}</p>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            {slips.length === 0 && (
              <div className="rounded-xl border border-dashed border-border bg-card p-16 text-center text-muted-foreground">
                <FileText className="mx-auto mb-3 h-10 w-10 opacity-25" />
                <p className="font-medium">{t('payslips.emptyTitle')}</p>
                <p className="text-sm mt-1">{t('payslips.emptyHint')}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
