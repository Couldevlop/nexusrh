import { useState } from 'react'
import { Calculator, ChevronDown } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

// Simulation simplifiée basée sur les taux français 2024
function simulateSalary(grossMonthly: number, employeeCount: number = 50): {
  grossMonthly: number
  netMonthly: number
  employerCost: number
  netAnnual: number
  employeeContributions: number
  employerContributions: number
} {
  // Taux approximatifs France 2024
  const employeeRate = 0.22 // ~22% cotisations salariales (CSG, CRDS, retraite, etc.)
  const employerRate = 0.42 // ~42% cotisations patronales

  const employeeContributions = grossMonthly * employeeRate
  const netMonthly = grossMonthly - employeeContributions
  const employerContributions = grossMonthly * employerRate
  const employerCost = grossMonthly + employerContributions

  return {
    grossMonthly,
    netMonthly: Math.round(netMonthly * 100) / 100,
    employerCost: Math.round(employerCost * 100) / 100,
    netAnnual: Math.round(netMonthly * 12 * 100) / 100,
    employeeContributions: Math.round(employeeContributions * 100) / 100,
    employerContributions: Math.round(employerContributions * 100) / 100,
  }
}

export function SalarySimulator() {
  const [grossInput, setGrossInput] = useState('3000')
  const [showDetails, setShowDetails] = useState(false)

  const gross = parseFloat(grossInput.replace(',', '.')) || 0
  const result = simulateSalary(gross)

  return (
    <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-5 border border-indigo-100">
      <div className="flex items-center gap-2 mb-4">
        <Calculator className="w-5 h-5 text-indigo-600" />
        <h3 className="font-semibold text-gray-900">Simulateur de salaire</h3>
        <span className="text-xs bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded-full">France 2024</span>
      </div>

      <div className="mb-4">
        <label className="text-xs font-medium text-gray-600 block mb-1.5">
          Salaire brut mensuel (€)
        </label>
        <input
          type="text"
          value={grossInput}
          onChange={(e) => setGrossInput(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
          placeholder="3000"
        />
      </div>

      {gross > 0 && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white rounded-lg p-3 border border-gray-100">
              <p className="text-xs text-gray-500">Net mensuel estimé</p>
              <p className="text-lg font-bold text-gray-900">{formatCurrency(result.netMonthly)}</p>
              <p className="text-xs text-gray-400">≈ {formatCurrency(result.netAnnual)} / an</p>
            </div>
            <div className="bg-white rounded-lg p-3 border border-gray-100">
              <p className="text-xs text-gray-500">Coût employeur</p>
              <p className="text-lg font-bold text-indigo-700">{formatCurrency(result.employerCost)}</p>
              <p className="text-xs text-gray-400">+{formatCurrency(result.employerContributions)} patronales</p>
            </div>
          </div>

          <button
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800"
          >
            <ChevronDown className={`w-3 h-3 transition-transform ${showDetails ? 'rotate-180' : ''}`} />
            {showDetails ? 'Masquer' : 'Voir'} le détail
          </button>

          {showDetails && (
            <div className="bg-white rounded-lg border border-gray-100 p-3 space-y-1.5 text-xs">
              <div className="flex justify-between text-gray-700">
                <span>Brut mensuel</span>
                <span className="font-mono font-medium">{formatCurrency(result.grossMonthly)}</span>
              </div>
              <div className="flex justify-between text-red-600">
                <span>Cotisations salariales (~22%)</span>
                <span className="font-mono">-{formatCurrency(result.employeeContributions)}</span>
              </div>
              <div className="flex justify-between text-gray-900 font-semibold border-t pt-1">
                <span>Net mensuel</span>
                <span className="font-mono">{formatCurrency(result.netMonthly)}</span>
              </div>
              <div className="flex justify-between text-blue-600 border-t pt-1">
                <span>Cotisations patronales (~42%)</span>
                <span className="font-mono">+{formatCurrency(result.employerContributions)}</span>
              </div>
              <div className="flex justify-between text-indigo-700 font-semibold border-t pt-1">
                <span>Coût total employeur</span>
                <span className="font-mono">{formatCurrency(result.employerCost)}</span>
              </div>
            </div>
          )}

          <p className="text-xs text-gray-400">
            * Estimation basée sur les taux moyens 2024. Résultat indicatif uniquement.
          </p>
        </div>
      )}
    </div>
  )
}
