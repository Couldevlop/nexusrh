import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, FileText, Download } from 'lucide-react'
import api from '@/lib/api'
import { formatCurrency } from '@/lib/utils'
import { PaySlipViewer } from '@/components/payroll/PaySlipViewer'
import type { PaySlip } from '@nexusrh/shared'

export function PaySlipsPage() {
  const [search, setSearch] = useState('')
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear())

  const { data: payslips, isLoading } = useQuery<PaySlip[]>({
    queryKey: ['all-payslips', selectedYear],
    queryFn: async () => {
      const res = await api.get('/payroll/payslips', { params: { year: selectedYear } })
      return res.data.data ?? []
    },
  })

  const filtered = payslips?.filter((ps) =>
    search === '' || String(ps.month).includes(search)
  ) ?? []

  const totalNet = filtered.reduce((s, ps) => s + Number(ps.netPayable), 0)
  const totalGross = filtered.reduce((s, ps) => s + Number(ps.grossSalary), 0)

  const years = Array.from({ length: 3 }, (_, i) => new Date().getFullYear() - i)

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bulletins de paie</h1>
          <p className="text-sm text-gray-500 mt-1">Historique et gestion des bulletins</p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50">
          <Download className="w-4 h-4" />
          Tout exporter
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Bulletins</p>
          <p className="text-2xl font-bold text-gray-900">{filtered.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Total brut</p>
          <p className="text-2xl font-bold text-gray-900">{formatCurrency(totalGross)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Total net</p>
          <p className="text-2xl font-bold text-indigo-700">{formatCurrency(totalNet)}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher..."
            className="w-full pl-9 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <select
          value={selectedYear}
          onChange={(e) => setSelectedYear(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {/* List */}
      <div className="space-y-2">
        {isLoading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 bg-gray-100 rounded-xl animate-pulse" />
          ))
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <FileText className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">Aucun bulletin pour cette période</p>
          </div>
        ) : (
          filtered.map((ps) => <PaySlipViewer key={ps.id} payslip={ps} />)
        )}
      </div>
    </div>
  )
}
