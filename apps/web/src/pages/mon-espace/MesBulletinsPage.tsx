import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { FileText, Download, Eye } from 'lucide-react'
import api from '@/lib/api'
import { formatCurrency, cn } from '@/lib/utils'

interface PaySlip {
  id: string
  month: number
  year: number
  netPayable: number
  grossSalary: number
  status: string
  pdfUrl: string | null
  viewedByEmployeeAt: string | null
}

export function MesBulletinsPage() {
  const queryClient = useQueryClient()

  const { data: payslips, isLoading } = useQuery<PaySlip[]>({
    queryKey: ['my-payslips'],
    queryFn: async () => {
      const res = await api.get<{ data: PaySlip[] }>('/payroll/my-payslips?limit=24')
      return res.data.data
    },
  })

  async function openOrDownloadPdf(id: string, download = false) {
    try {
      const res = await api.get(`/payroll/my-payslips/${id}/pdf`, {
        responseType: 'blob',
      })
      const blob = new Blob([res.data as Blob], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      if (download) {
        const ps = payslips?.find((p) => p.id === id)
        const filename = ps
          ? `bulletin-${ps.year}-${String(ps.month).padStart(2, '0')}.pdf`
          : `bulletin-${id}.pdf`
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 5000)
      } else {
        // Ouvrir dans un nouvel onglet
        window.open(url, '_blank')
      }
      queryClient.invalidateQueries({ queryKey: ['my-payslips'] })
      queryClient.invalidateQueries({ queryKey: ['my-last-payslip'] })
    } catch {
      // Fallback si pdfUrl existe (stocké dans MinIO)
      const ps = payslips?.find((p) => p.id === id)
      if (ps?.pdfUrl) window.open(ps.pdfUrl, '_blank')
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Mes bulletins de paie</h1>
        <p className="text-sm text-gray-500 mt-1">
          {payslips?.length ?? 0} bulletin{(payslips?.length ?? 0) > 1 ? 's' : ''} disponible
          {(payslips?.length ?? 0) > 1 ? 's' : ''}
        </p>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
      >
        {isLoading ? (
          <div className="p-6 space-y-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-14 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : (payslips ?? []).length === 0 ? (
          <div className="text-center py-16">
            <FileText className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 font-medium">Aucun bulletin disponible</p>
            <p className="text-sm text-gray-400 mt-1">
              Vos bulletins de paie apparaîtront ici une fois générés.
            </p>
          </div>
        ) : (
          <>
            <div className="bg-gray-50 px-5 py-3 border-b border-gray-100">
              <div className="grid grid-cols-4 gap-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <span>Période</span>
                <span>Salaire brut</span>
                <span>Net à payer</span>
                <span className="text-right">Actions</span>
              </div>
            </div>
            <div className="divide-y divide-gray-100">
              {(payslips ?? []).map((ps, idx) => {
                const isNew = !ps.viewedByEmployeeAt
                return (
                  <motion.div
                    key={ps.id}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.03 }}
                    className={cn(
                      'grid grid-cols-4 gap-4 items-center px-5 py-4 hover:bg-gray-50 transition-colors',
                      isNew && 'bg-indigo-50/40'
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
                          isNew ? 'bg-indigo-100' : 'bg-gray-100'
                        )}
                      >
                        <FileText
                          className={cn(
                            'w-5 h-5',
                            isNew ? 'text-indigo-600' : 'text-gray-400'
                          )}
                        />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-gray-900 capitalize">
                            {new Date(ps.year, ps.month - 1).toLocaleDateString('fr-FR', {
                              month: 'long',
                              year: 'numeric',
                            })}
                          </p>
                          {isNew && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">
                              Nouveau
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <p className="text-sm text-gray-700">
                      {formatCurrency(Number(ps.grossSalary))}
                    </p>

                    <p className="text-sm font-semibold text-gray-900">
                      {formatCurrency(Number(ps.netPayable))}
                    </p>

                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openOrDownloadPdf(ps.id, false)}
                        className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
                        title="Consulter le bulletin"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => openOrDownloadPdf(ps.id, true)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        PDF
                      </button>
                    </div>
                  </motion.div>
                )
              })}
            </div>
          </>
        )}
      </motion.div>
    </div>
  )
}
