import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { MapPin, Mail, Phone } from 'lucide-react'
import { cn, getStatusColor, getInitials, formatDate } from '@/lib/utils'
import { RetentionScore } from './RetentionScore'
import type { Employee } from '@nexusrh/shared'

interface EmployeeCardProps {
  employee: Employee
}

export function EmployeeCard({ employee }: EmployeeCardProps) {
  const navigate = useNavigate()

  return (
    <motion.div
      whileHover={{ y: -2 }}
      onClick={() => navigate(`/employees/${employee.id}`)}
      className="bg-white rounded-xl border border-gray-200 p-5 cursor-pointer hover:shadow-md transition-shadow"
    >
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
          {getInitials(employee.firstName, employee.lastName)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-gray-900 truncate">
              {employee.firstName} {employee.lastName}
            </h3>
            <span className={cn(
              'text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0',
              getStatusColor(employee.status)
            )}>
              {employee.status}
            </span>
          </div>
          <p className="text-sm text-gray-500 truncate mt-0.5">
            {employee.jobTitle ?? 'Poste non défini'}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-1.5">
        {employee.email && (
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Mail className="w-3 h-3" />
            <span className="truncate">{employee.email}</span>
          </div>
        )}
        {employee.phone && (
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Phone className="w-3 h-3" />
            <span>{employee.phone}</span>
          </div>
        )}
        {employee.hireDate && (
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <MapPin className="w-3 h-3" />
            <span>Embauché le {formatDate(employee.hireDate)}</span>
          </div>
        )}
      </div>

      {employee.retentionScore !== null && employee.retentionScore !== undefined && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <RetentionScore
            score={Number(employee.retentionScore)}
            compact
          />
        </div>
      )}
    </motion.div>
  )
}
