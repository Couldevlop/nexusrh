import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  FileText, Calendar, DollarSign, BookOpen, Settings,
  Download, Plus, Clock, CheckCircle
} from 'lucide-react'
import { useCurrentUser } from '@/hooks/useAuth'
import { usePaySlips } from '@/hooks/usePayroll'
import { useAbsenceBalances } from '@/hooks/useAbsences'
import { formatDate, formatCurrency } from '@/lib/utils'

export function SelfServicePage() {
  const { user } = useCurrentUser()
  const [activeSection, setActiveSection] = useState<string | null>(null)

  const { data: payslips } = usePaySlips(user?.employeeId ?? '')
  const { data: balances } = useAbsenceBalances(user?.employeeId ?? '')

  const quickActions = [
    {
      id: 'absence',
      icon: Calendar,
      label: 'Demander un congé',
      description: 'Soumettre une demande d\'absence',
      color: 'bg-purple-100 text-purple-600',
    },
    {
      id: 'payslips',
      icon: FileText,
      label: 'Mes bulletins',
      description: 'Consulter et télécharger',
      color: 'bg-indigo-100 text-indigo-600',
    },
    {
      id: 'expenses',
      icon: DollarSign,
      label: 'Note de frais',
      description: 'Déclarer des frais professionnels',
      color: 'bg-green-100 text-green-600',
    },
    {
      id: 'training',
      icon: BookOpen,
      label: 'Formations',
      description: 'Voir les formations disponibles',
      color: 'bg-yellow-100 text-yellow-600',
    },
  ]

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* Welcome banner */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-xl p-6 text-white"
      >
        <h1 className="text-xl font-bold">
          Bonjour {user?.firstName} 👋
        </h1>
        <p className="text-indigo-200 text-sm mt-1">
          Votre espace collaborateur — accès à vos documents et demandes
        </p>
      </motion.div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {quickActions.map((action, idx) => {
          const Icon = action.icon
          return (
            <motion.button
              key={action.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              onClick={() => setActiveSection(action.id)}
              className="bg-white rounded-xl border border-gray-200 p-4 text-left hover:shadow-md transition-shadow"
            >
              <div className={`w-10 h-10 rounded-xl ${action.color} flex items-center justify-center mb-3`}>
                <Icon className="w-5 h-5" />
              </div>
              <p className="text-sm font-semibold text-gray-900">{action.label}</p>
              <p className="text-xs text-gray-500 mt-0.5">{action.description}</p>
            </motion.button>
          )
        })}
      </div>

      {/* Absence balances */}
      {balances && balances.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Mes soldes de congés</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {balances.slice(0, 4).map((balance) => {
              const remaining = Number(balance.acquired) - Number(balance.taken)
              return (
                <div key={balance.id} className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500">{balance.absenceTypeId}</p>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-xl font-bold text-gray-900">{remaining}</span>
                    <span className="text-xs text-gray-400">j</span>
                  </div>
                  <div className="h-1 bg-gray-200 rounded-full mt-1.5">
                    <div
                      className="h-full bg-indigo-500 rounded-full"
                      style={{
                        width: `${Math.min(100, (Number(balance.taken) / Math.max(1, Number(balance.acquired))) * 100)}%`
                      }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Recent payslips */}
      {payslips && payslips.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-900">Mes derniers bulletins</h2>
            <button className="text-xs text-indigo-600 hover:underline">Voir tout</button>
          </div>
          <div className="space-y-2">
            {payslips.slice(0, 3).map((ps) => (
              <div key={ps.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className="text-sm font-medium text-gray-700 capitalize">
                      {new Date(ps.year ?? 0, (ps.month ?? 1) - 1).toLocaleDateString('fr-FR', {
                        month: 'long', year: 'numeric'
                      })}
                    </p>
                    <p className="text-xs text-gray-500">Net : {formatCurrency(Number(ps.netPayable))}</p>
                  </div>
                </div>
                {ps.pdfUrl && (
                  <a
                    href={ps.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-indigo-600 hover:underline"
                  >
                    <Download className="w-3 h-3" />
                    PDF
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending requests */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Mes demandes en cours</h2>
        <div className="text-center py-6 text-gray-400">
          <CheckCircle className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Aucune demande en attente</p>
        </div>
      </div>
    </div>
  )
}
