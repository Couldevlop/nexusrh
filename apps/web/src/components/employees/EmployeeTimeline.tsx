import { motion } from 'framer-motion'
import {
  Briefcase, TrendingUp, AlertTriangle, Plane, BookOpen,
  Star, UserMinus, Gift, Award
} from 'lucide-react'
import { formatDate } from '@/lib/utils'
import type { HREvent } from '@nexusrh/shared'

interface EmployeeTimelineProps {
  events: HREvent[]
}

const EVENT_CONFIG: Record<string, {
  icon: React.ElementType
  color: string
  bg: string
}> = {
  hire: { icon: Briefcase, color: 'text-green-600', bg: 'bg-green-100' },
  promotion: { icon: TrendingUp, color: 'text-indigo-600', bg: 'bg-indigo-100' },
  salary_change: { icon: TrendingUp, color: 'text-blue-600', bg: 'bg-blue-100' },
  warning: { icon: AlertTriangle, color: 'text-orange-600', bg: 'bg-orange-100' },
  absence: { icon: Plane, color: 'text-purple-600', bg: 'bg-purple-100' },
  training: { icon: BookOpen, color: 'text-teal-600', bg: 'bg-teal-100' },
  evaluation: { icon: Star, color: 'text-yellow-600', bg: 'bg-yellow-100' },
  termination: { icon: UserMinus, color: 'text-red-600', bg: 'bg-red-100' },
  anniversary: { icon: Gift, color: 'text-pink-600', bg: 'bg-pink-100' },
  award: { icon: Award, color: 'text-amber-600', bg: 'bg-amber-100' },
}

export function EmployeeTimeline({ events }: EmployeeTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="text-center py-8 text-gray-400">
        <p className="text-sm">Aucun événement RH enregistré</p>
      </div>
    )
  }

  const sorted = [...events].sort(
    (a, b) => new Date(b.eventDate).getTime() - new Date(a.eventDate).getTime()
  )

  return (
    <div className="relative">
      <div className="absolute left-5 top-0 bottom-0 w-0.5 bg-gray-100" />
      <div className="space-y-6">
        {sorted.map((event, idx) => {
          const cfg = EVENT_CONFIG[event.type] ?? {
            icon: Briefcase,
            color: 'text-gray-600',
            bg: 'bg-gray-100',
          }
          const Icon = cfg.icon

          return (
            <motion.div
              key={event.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.05 }}
              className="flex gap-4 pl-0"
            >
              <div className={`relative z-10 flex-shrink-0 w-10 h-10 rounded-full ${cfg.bg} flex items-center justify-center`}>
                <Icon className={`w-4 h-4 ${cfg.color}`} />
              </div>
              <div className="flex-1 pb-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{event.title}</p>
                    {event.description && (
                      <p className="text-xs text-gray-500 mt-0.5">{event.description}</p>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 whitespace-nowrap flex-shrink-0">
                    {formatDate(event.eventDate)}
                  </span>
                </div>
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
