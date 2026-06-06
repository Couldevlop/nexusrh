import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, formatFCFA, formatMonth } from '@/lib/api'
import { FileText, Eye } from 'lucide-react'
import PaySlipTransparentModal from '@/components/payroll/PaySlipTransparentModal'

interface PaySlip {
  id: string; month: string; employee_id: string
  first_name: string; last_name: string; cnps_number: string
  gross_salary: string; net_payable: string; its: string; total_cnps_sal: string
  status: string; payment_method: string; payment_status: string
  generated_at: string
}

export default function PaySlipsPage() {
  const { t } = useTranslation('payroll')
  const [month, setMonth] = useState('')
  const [openSlipId, setOpenSlipId] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: PaySlip[] }>({
    queryKey: ['payslips', month],
    queryFn: () => api.get(`/payroll/payslips${month ? `?month=${month}` : ''}`).then(r => r.data),
  })

  const slips = data?.data ?? []

  const payStatusColor: Record<string, string> = {
    paid: 'bg-green-100 text-green-700',
    pending: 'bg-yellow-100 text-yellow-700',
    failed: 'bg-red-100 text-red-700',
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('payslips.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('payslips.count', { count: slips.length })}</p>
        </div>
        <select
          value={month}
          onChange={e => setMonth(e.target.value)}
          className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
        >
          <option value="">{t('payslips.allMonths')}</option>
          {Array.from({ length: 12 }, (_, i) => {
            const d = new Date()
            d.setMonth(d.getMonth() - i)
            const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
            return <option key={m} value={m}>{formatMonth(m)}</option>
          })}
        </select>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                  <th className="p-4">{t('payslips.colEmployee')}</th>
                  <th className="p-4">{t('payslips.colPeriod')}</th>
                  <th className="p-4 text-right">{t('payslips.colGross')}</th>
                  <th className="p-4 text-right">{t('payslips.colNet')}</th>
                  <th className="p-4 text-right">{t('payslips.colCnps')}</th>
                  <th className="p-4 text-right">{t('payslips.colIts')}</th>
                  <th className="p-4">{t('payslips.colPayment')}</th>
                  <th className="p-4 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {slips.map(slip => (
                  <tr
                    key={slip.id}
                    className="hover:bg-muted/30 cursor-pointer"
                    onClick={() => setOpenSlipId(slip.id)}
                  >
                    <td className="p-4">
                      <p className="font-medium">{slip.first_name} {slip.last_name}</p>
                      <p className="text-xs text-muted-foreground font-mono">{slip.cnps_number ?? '—'}</p>
                    </td>
                    <td className="p-4 capitalize">{formatMonth(slip.month)}</td>
                    <td className="p-4 text-right font-mono">{formatFCFA(parseInt(slip.gross_salary ?? '0'))}</td>
                    <td className="p-4 text-right font-mono font-semibold">{formatFCFA(parseInt(slip.net_payable ?? '0'))}</td>
                    <td className="p-4 text-right font-mono text-orange-600">{formatFCFA(parseInt(slip.total_cnps_sal ?? '0'))}</td>
                    <td className="p-4 text-right font-mono text-blue-600">{formatFCFA(parseInt(slip.its ?? '0'))}</td>
                    <td className="p-4">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${payStatusColor[slip.payment_status] ?? 'bg-muted text-muted-foreground'}`}>
                        {slip.payment_status === 'paid' ? t('payslips.payStatus.paid') : slip.payment_status === 'pending' ? t('payslips.payStatus.pending') : slip.payment_status}
                      </span>
                      <p className="text-xs text-muted-foreground mt-0.5 capitalize">{slip.payment_method?.replace('_', ' ')}</p>
                    </td>
                    <td className="p-4 text-right">
                      <Eye className="inline h-4 w-4 text-muted-foreground" />
                    </td>
                  </tr>
                ))}
                {slips.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-muted-foreground">
                      <FileText className="mx-auto mb-2 h-8 w-8 opacity-30" />
                      {t('payslips.empty')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openSlipId && (
        <PaySlipTransparentModal slipId={openSlipId} onClose={() => setOpenSlipId(null)} />
      )}
    </div>
  )
}
