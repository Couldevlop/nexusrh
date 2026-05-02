import { useState } from 'react'
import { FileText, Download, Eye, ChevronDown, ChevronUp } from 'lucide-react'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type { PaySlip } from '@nexusrh/shared'

interface PaySlipViewerProps {
  payslip: PaySlip
}

const TYPE_LABELS: Record<string, string> = {
  earning: 'Gain',
  deduction: 'Retenue',
  employee_contribution: 'Cotisation salariale',
  employer_contribution: 'Cotisation patronale',
  info: 'Information',
}

const TYPE_COLORS: Record<string, string> = {
  earning: 'text-green-700',
  deduction: 'text-red-700',
  employee_contribution: 'text-orange-700',
  employer_contribution: 'text-blue-700',
  info: 'text-gray-600',
}

export function PaySlipViewer({ payslip }: PaySlipViewerProps) {
  const [expanded, setExpanded] = useState(false)

  const periodLabel = new Date(
    payslip.year ?? 0,
    (payslip.month ?? 1) - 1
  ).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

  const groupedLines = payslip.lines?.reduce((acc, line) => {
    const type = line.type ?? 'info'
    if (!acc[type]) acc[type] = []
    acc[type].push(line)
    return acc
  }, {} as Record<string, typeof payslip.lines>)

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between p-4 bg-gray-50 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-indigo-100 rounded-lg flex items-center justify-center">
            <FileText className="w-4 h-4 text-indigo-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900 capitalize">{periodLabel}</p>
            <p className="text-xs text-gray-500">
              Brut : {formatCurrency(Number(payslip.grossSalary))} · Net : {formatCurrency(Number(payslip.netPayable))}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {payslip.pdfUrl && (
            <a
              href={payslip.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 px-2 py-1 text-xs text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-md transition-colors"
            >
              <Download className="w-3 h-3" />
              PDF
            </a>
          )}
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )}
        </div>
      </div>

      {/* Detail */}
      {expanded && (
        <div className="p-4 space-y-4">
          {Object.entries(TYPE_LABELS).map(([type, label]) => {
            const lines = groupedLines?.[type]
            if (!lines || lines.length === 0) return null
            return (
              <div key={type}>
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  {label}
                </h4>
                <div className="space-y-1">
                  {lines.map((line, idx) => (
                    <div key={idx} className="flex justify-between items-center text-sm py-1">
                      <div>
                        <span className="text-gray-700">{line.label}</span>
                        {line.base > 0 && (
                          <span className="text-gray-400 text-xs ml-2">
                            Base : {formatCurrency(line.base)}
                            {line.employeeRate && ` × ${(line.employeeRate * 100).toFixed(2)}%`}
                          </span>
                        )}
                      </div>
                      <span className={cn('font-medium', TYPE_COLORS[type])}>
                        {formatCurrency(line.employeeAmount)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}

          {/* Totals */}
          <div className="border-t pt-3 space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Salaire brut</span>
              <span className="font-medium">{formatCurrency(Number(payslip.grossSalary))}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Net avant impôt</span>
              <span className="font-medium">{formatCurrency(Number(payslip.netBeforeTax))}</span>
            </div>
            {Number(payslip.incomeTax) > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Prélèvement à la source</span>
                <span className="font-medium text-red-600">-{formatCurrency(Number(payslip.incomeTax))}</span>
              </div>
            )}
            <div className="flex justify-between text-sm font-semibold pt-1 border-t">
              <span className="text-gray-900">Net à payer</span>
              <span className="text-indigo-700">{formatCurrency(Number(payslip.netPayable))}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
