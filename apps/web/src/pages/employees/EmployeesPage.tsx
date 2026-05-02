import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Plus, Filter, Download } from 'lucide-react'
import { motion } from 'framer-motion'
import { useEmployees } from '@/hooks/useEmployees'
import { DataTable, type Column } from '@/components/shared/DataTable'
import { formatDate, getStatusColor, getRiskColor, cn } from '@/lib/utils'
import type { EmployeeListItem } from '@nexusrh/shared'

const columns: Column<EmployeeListItem & Record<string, unknown>>[] = [
  {
    key: 'name',
    header: 'Collaborateur',
    render: (_, row) => (
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-xs font-bold text-indigo-700 flex-shrink-0">
          {row.firstName?.toString().charAt(0)}{row.lastName?.toString().charAt(0)}
        </div>
        <div>
          <p className="font-medium text-gray-900 text-sm">
            {row.firstName} {row.lastName}
          </p>
          <p className="text-xs text-gray-400">{String(row.employeeNumber ?? '')}</p>
        </div>
      </div>
    ),
  },
  {
    key: 'jobTitle',
    header: 'Poste',
    sortable: true,
    render: (value) => (
      <span className="text-sm text-gray-700">{String(value ?? '-')}</span>
    ),
  },
  {
    key: 'departmentName',
    header: 'Département',
    sortable: true,
    render: (value) => (
      <span className="text-sm text-gray-600">{String(value ?? '-')}</span>
    ),
  },
  {
    key: 'hireDate',
    header: 'Ancienneté',
    sortable: true,
    render: (value) => (
      <span className="text-sm text-gray-600">{formatDate(String(value ?? ''))}</span>
    ),
  },
  {
    key: 'status',
    header: 'Statut',
    render: (value) => (
      <span className={cn('text-xs px-2 py-1 rounded-full font-medium', getStatusColor(String(value ?? '')))} >
        {String(value ?? '-')}
      </span>
    ),
  },
  {
    key: 'burnoutRisk',
    header: 'Risque burnout',
    render: (value) => value ? (
      <span className={cn('text-xs px-2 py-1 rounded-full font-medium', getRiskColor(String(value)))}>
        {String(value)}
      </span>
    ) : <span className="text-gray-300">-</span>,
  },
  {
    key: 'retentionScore',
    header: 'Score rétention',
    render: (value) => value ? (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-gray-200 rounded-full max-w-16">
          <div
            className="h-full bg-indigo-600 rounded-full"
            style={{ width: `${Number(value) * 100}%` }}
          />
        </div>
        <span className="text-xs text-gray-600 font-mono">
          {(Number(value) * 100).toFixed(0)}%
        </span>
      </div>
    ) : <span className="text-gray-300">-</span>,
  },
]

export function EmployeesPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')

  const { data, isLoading } = useEmployees({
    page,
    limit: 25,
    search: search || undefined,
    status: status || undefined,
  })

  return (
    <div className="p-6 space-y-5 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Collaborateurs</h1>
          <p className="text-sm text-gray-500 mt-1">
            {data?.total ?? 0} collaborateurs
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            <Download className="w-4 h-4" />
            Exporter
          </button>
          <button
            onClick={() => navigate('/employees/new')}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Nouveau collaborateur
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un collaborateur..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">Tous les statuts</option>
          <option value="active">Actif</option>
          <option value="inactive">Inactif</option>
          <option value="onLeave">En congé</option>
          <option value="terminated">Parti</option>
        </select>
      </div>

      {/* Table */}
      <DataTable
        data={(data?.data ?? []) as (EmployeeListItem & Record<string, unknown>)[]}
        columns={columns}
        isLoading={isLoading}
        emptyMessage="Aucun collaborateur trouvé"
        onRowClick={(row) => navigate(`/employees/${row.id}`)}
      />

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-gray-500">
            {((page - 1) * 25) + 1}–{Math.min(page * 25, data.total)} sur {data.total}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition-colors"
            >
              Précédent
            </button>
            <button
              onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
              disabled={page === data.totalPages}
              className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition-colors"
            >
              Suivant
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
