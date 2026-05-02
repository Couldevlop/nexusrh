/**
 * OrgChartPage — Organigramme interactif de l'entreprise.
 * Utilise une mise en page arbre (tree layout) avec Framer Motion.
 * Filtres : département, entité légale. Zoom + pan natif CSS.
 */
import { useState, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Users, ZoomIn, ZoomOut, Maximize2, Download, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'

interface EmployeeNode {
  id: string
  firstName: string
  lastName: string
  jobTitle: string | null
  department: string | null
  managerId: string | null
  avatarUrl: string | null
  status: string
  children?: EmployeeNode[]
}

// ── Génère une couleur d'avatar à partir du nom ───────────────────────────────
function getAvatarColor(name: string): string {
  const colors = ['#4F46E5', '#7C3AED', '#DB2777', '#059669', '#D97706', '#DC2626', '#0891B2']
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
  return colors[Math.abs(hash) % colors.length]!
}

// ── Composant nœud employé ────────────────────────────────────────────────────
function EmployeeCard({ employee, depth = 0 }: { employee: EmployeeNode; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = (employee.children?.length ?? 0) > 0
  const initials = `${employee.firstName[0] ?? ''}${employee.lastName[0] ?? ''}`.toUpperCase()
  const color = getAvatarColor(employee.firstName + employee.lastName)

  return (
    <div className="flex flex-col items-center">
      {/* Carte employé */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: depth * 0.05 }}
        className="relative"
      >
        <div className={`bg-white border-2 rounded-xl shadow-sm hover:shadow-md transition-all cursor-pointer w-44
          ${employee.status === 'active' ? 'border-gray-200 hover:border-indigo-300' : 'border-dashed border-gray-200 opacity-60'}`}
        >
          <div className="p-3 text-center">
            {employee.avatarUrl ? (
              <img src={employee.avatarUrl} alt={`${employee.firstName} ${employee.lastName}`}
                className="w-12 h-12 rounded-full mx-auto mb-2 object-cover" />
            ) : (
              <div className="w-12 h-12 rounded-full mx-auto mb-2 flex items-center justify-center text-white text-sm font-bold"
                style={{ backgroundColor: color }}>
                {initials}
              </div>
            )}
            <div className="text-xs font-semibold text-gray-900 leading-tight truncate">
              {employee.firstName} {employee.lastName}
            </div>
            {employee.jobTitle && (
              <div className="text-xs text-gray-500 truncate mt-0.5">{employee.jobTitle}</div>
            )}
            {employee.department && (
              <div className="mt-1.5 inline-block px-1.5 py-0.5 bg-indigo-50 text-indigo-700 rounded text-xs">
                {employee.department}
              </div>
            )}
          </div>

          {/* Bouton expand/collapse */}
          {hasChildren && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="absolute -bottom-3 left-1/2 -translate-x-1/2 w-6 h-6 bg-white border border-gray-300 rounded-full flex items-center justify-center shadow-sm hover:bg-indigo-50 hover:border-indigo-300 z-10"
            >
              {expanded
                ? <ChevronDown className="w-3 h-3 text-gray-600" />
                : <ChevronRight className="w-3 h-3 text-gray-600" />}
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-indigo-600 rounded-full text-white text-xs flex items-center justify-center leading-none">
                {employee.children!.length}
              </span>
            </button>
          )}
        </div>
      </motion.div>

      {/* Enfants */}
      {hasChildren && expanded && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center mt-8"
        >
          {/* Ligne verticale */}
          <div className="w-px h-6 bg-gray-300" />
          {/* Ligne horizontale */}
          <div className="relative flex gap-8">
            {employee.children!.length > 1 && (
              <div className="absolute top-0 left-0 right-0 h-px bg-gray-300" />
            )}
            {employee.children!.map((child) => (
              <div key={child.id} className="flex flex-col items-center pt-0">
                <div className="w-px h-6 bg-gray-300" />
                <EmployeeCard employee={child} depth={depth + 1} />
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  )
}

// ── Construire l'arbre depuis la liste plate ──────────────────────────────────
function buildTree(employees: EmployeeNode[]): EmployeeNode[] {
  const map = new Map<string, EmployeeNode>()
  for (const emp of employees) {
    map.set(emp.id, { ...emp, children: [] })
  }

  const roots: EmployeeNode[] = []
  for (const emp of map.values()) {
    if (emp.managerId && map.has(emp.managerId)) {
      map.get(emp.managerId)!.children!.push(emp)
    } else {
      roots.push(emp)
    }
  }
  return roots
}

// ── Page principale ───────────────────────────────────────────────────────────
export function OrgChartPage() {
  const [zoom, setZoom] = useState(1)
  const [departmentFilter, setDepartmentFilter] = useState<string>('all')
  const containerRef = useRef<HTMLDivElement>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['employees-orgchart'],
    queryFn: async () => {
      const { data } = await api.get('/employees?limit=500&status=active')
      return data.data as Array<{
        id: string
        firstName: string
        lastName: string
        jobTitle: string | null
        department: string | null
        managerId: string | null
        avatarUrl: string | null
        status: string
      }>
    },
  })

  const { data: departments } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => {
      const { data } = await api.get('/employees/departments')
      return data.data as Array<{ id: string; name: string }>
    },
  })

  const filtered = (data ?? []).filter((e) =>
    departmentFilter === 'all' || e.department === departmentFilter
  )

  const tree = buildTree(filtered)

  const handleDownload = () => {
    const element = containerRef.current
    if (!element) return
    // Export simple via CSS print
    window.print()
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Toolbar */}
      <div className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Users className="w-5 h-5 text-indigo-600" />
          <span className="font-semibold text-gray-900">Organigramme</span>
          <span className="text-sm text-gray-500">
            {filtered.length} collaborateur{filtered.length > 1 ? 's' : ''}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Filtre département */}
          <select
            value={departmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="all">Tous les départements</option>
            {(departments ?? []).map((d) => (
              <option key={d.id} value={d.name}>{d.name}</option>
            ))}
          </select>

          {/* Zoom */}
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            <button onClick={() => setZoom(Math.max(0.4, zoom - 0.1))}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-white hover:shadow-sm">
              <ZoomOut className="w-4 h-4 text-gray-600" />
            </button>
            <span className="text-xs text-gray-600 w-12 text-center font-medium">
              {Math.round(zoom * 100)}%
            </span>
            <button onClick={() => setZoom(Math.min(2, zoom + 0.1))}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-white hover:shadow-sm">
              <ZoomIn className="w-4 h-4 text-gray-600" />
            </button>
            <button onClick={() => setZoom(1)}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-white hover:shadow-sm">
              <Maximize2 className="w-4 h-4 text-gray-600" />
            </button>
          </div>

          <button onClick={handleDownload}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
            <Download className="w-4 h-4" />
            Exporter
          </button>
        </div>
      </div>

      {/* Contenu organigramme */}
      <div className="flex-1 overflow-auto p-8">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
              <p className="text-sm text-gray-500">Chargement de l'organigramme...</p>
            </div>
          </div>
        ) : tree.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-center">
            <div>
              <Users className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">Aucun employé trouvé</p>
            </div>
          </div>
        ) : (
          <div
            ref={containerRef}
            style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', transition: 'transform 0.2s ease' }}
          >
            <div className="flex gap-12 justify-center flex-wrap">
              {tree.map((root) => (
                <EmployeeCard key={root.id} employee={root} depth={0} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Légende */}
      <div className="bg-white border-t px-6 py-2 flex items-center gap-6 text-xs text-gray-500">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-indigo-600" />
          <span>Actif</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full border border-dashed border-gray-400" />
          <span>Inactif</span>
        </div>
        <span>•</span>
        <span>Cliquez sur le badge pour déplier/replier les équipes</span>
      </div>
    </div>
  )
}
