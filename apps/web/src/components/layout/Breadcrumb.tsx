import { Link, useLocation } from 'react-router-dom'
import { ChevronRight, Home } from 'lucide-react'
import { cn } from '@/lib/utils'

const ROUTE_LABELS: Record<string, string> = {
  dashboard: 'Tableau de bord',
  employees: 'Collaborateurs',
  new: 'Nouveau',
  payroll: 'Paie',
  payslips: 'Bulletins',
  settings: 'Paramètres',
  absences: 'Absences',
  recruitment: 'Recrutement',
  training: 'Formation',
  expenses: 'Frais',
  careers: 'Carrières',
  reporting: 'Reporting',
  'self-service': 'Espace collaborateur',
}

export function Breadcrumb() {
  const location = useLocation()
  const segments = location.pathname.split('/').filter(Boolean)

  if (segments.length === 0) return null

  return (
    <nav className="flex items-center gap-1 text-sm" aria-label="Breadcrumb">
      <Link
        to="/dashboard"
        className="text-gray-400 hover:text-gray-600 transition-colors"
      >
        <Home className="w-3.5 h-3.5" />
      </Link>
      {segments.map((segment, idx) => {
        const path = '/' + segments.slice(0, idx + 1).join('/')
        const label = ROUTE_LABELS[segment] ?? segment
        const isLast = idx === segments.length - 1
        const isId = /^[0-9a-f-]{36}$/.test(segment)

        return (
          <span key={path} className="flex items-center gap-1">
            <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
            {isLast || isId ? (
              <span className={cn(
                'font-medium',
                isLast ? 'text-gray-700' : 'text-gray-400'
              )}>
                {isId ? '...' : label}
              </span>
            ) : (
              <Link
                to={path}
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
