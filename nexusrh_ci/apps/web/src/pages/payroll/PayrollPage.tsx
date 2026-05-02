import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, formatFCFA, formatMonth } from '@/lib/api'
import { Loader2, Lock, Calculator, Download, BookOpen } from 'lucide-react'

interface PayPeriod {
  id: string; month: string; status: string
  total_gross: string; total_net: string; total_cnps: string; total_its: string
  employees_count: string; closed_at: string | null
}

export default function PayrollPage() {
  const queryClient = useQueryClient()
  const [selectedMonth, setSelectedMonth] = useState<string>('')
  const [closingResult, setClosingResult] = useState<{
    employeesCount: number; totals: Record<string, number>
  } | null>(null)
  const [livreYear, setLivreYear] = useState(new Date().getFullYear().toString())
  const [livreLoading, setLivreLoading] = useState(false)

  const { data: periodsData, isLoading } = useQuery<{ data: PayPeriod[] }>({
    queryKey: ['payroll-periods'],
    queryFn: () => api.get('/payroll/periods').then(r => r.data),
  })

  const closeMut = useMutation({
    mutationFn: (month: string) => api.post(`/payroll/periods/${month}/close`),
    onSuccess: (res) => {
      setClosingResult(res.data as { employeesCount: number; totals: Record<string, number> })
      queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
    },
  })

  const periods = periodsData?.data ?? []

  const exportLivre = async () => {
    setLivreLoading(true)
    try {
      const res = await api.get(`/payroll/livre-de-paie/${livreYear}/export`, { responseType: 'blob' })
      const url = URL.createObjectURL(new Blob([res.data as BlobPart]))
      const a = document.createElement('a')
      a.href = url
      a.download = `livre-de-paie-${livreYear}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setLivreLoading(false)
    }
  }

  // Générer les 12 derniers mois possibles
  const availableMonths = Array.from({ length: 12 }, (_, i) => {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Paie CI — Clôture mensuelle</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Moteur CNPS 2024 + ITS/DGI · Devise : FCFA (XOF)
        </p>
      </div>

      {/* Clôture */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-4 flex items-center gap-2">
          <Lock className="h-4 w-4" /> Clôturer une période
        </h2>

        <div className="flex items-end gap-3">
          <div>
            <label className="text-sm font-medium mb-1 block">Mois à clôturer</label>
            <select
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
            >
              <option value="">-- Sélectionner --</option>
              {availableMonths.map(m => (
                <option key={m} value={m} disabled={periods.some(p => p.month === m && p.status === 'closed')}>
                  {formatMonth(m)} {periods.some(p => p.month === m && p.status === 'closed') ? '(clôturée)' : ''}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => selectedMonth && closeMut.mutate(selectedMonth)}
            disabled={!selectedMonth || closeMut.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {closeMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            <Lock className="h-4 w-4" />
            Clôturer & Générer les bulletins
          </button>
        </div>

        {closeMut.isError && (
          <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {(closeMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Erreur lors de la clôture'}
          </div>
        )}

        {closingResult && (
          <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4">
            <p className="font-medium text-green-800 mb-2">
              Période clôturée — {closingResult.employeesCount} bulletins générés
            </p>
            <div className="grid grid-cols-2 gap-2 text-sm text-green-700">
              <p>Masse salariale brute : <strong>{formatFCFA(closingResult.totals['grossSalary'] ?? 0)}</strong></p>
              <p>Net total à payer : <strong>{formatFCFA(closingResult.totals['netPayable'] ?? 0)}</strong></p>
              <p>Total CNPS : <strong>{formatFCFA(closingResult.totals['cnps'] ?? 0)}</strong></p>
              <p>Total ITS : <strong>{formatFCFA(closingResult.totals['its'] ?? 0)}</strong></p>
            </div>
          </div>
        )}
      </div>

      {/* Livre de paie numérique */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-4 flex items-center gap-2">
          <BookOpen className="h-4 w-4" /> Livre de paie numérique
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          Export CSV format Inspection du Travail CI — récapitulatif annuel de tous les bulletins.
        </p>
        <div className="flex items-end gap-3">
          <div>
            <label className="text-sm font-medium mb-1 block">Année</label>
            <select value={livreYear} onChange={e => setLivreYear(e.target.value)}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
              {[0, 1, 2, 3].map(i => {
                const y = (new Date().getFullYear() - i).toString()
                return <option key={y} value={y}>{y}</option>
              })}
            </select>
          </div>
          <button
            onClick={exportLivre}
            disabled={livreLoading}
            className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {livreLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Exporter CSV
          </button>
        </div>
        <div className="mt-3 flex gap-4 text-xs text-muted-foreground">
          <span>• 20 colonnes règlementaires</span>
          <span>• Totaux mensuels inclus</span>
          <span>• En-tête employeur (CNPS, RCCM)</span>
          <span>• Encodage UTF-8</span>
        </div>
      </div>

      {/* Historique des périodes */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-6 py-4">
          <h2 className="font-semibold">Historique des périodes</h2>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="p-4">Période</th>
                <th className="p-4 text-right">Brut total</th>
                <th className="p-4 text-right">Net total</th>
                <th className="p-4 text-right">CNPS total</th>
                <th className="p-4 text-right">ITS total</th>
                <th className="p-4">Statut</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {periods.map(p => (
                <tr key={p.id} className="hover:bg-muted/30">
                  <td className="p-4 font-medium capitalize">{formatMonth(p.month)}</td>
                  <td className="p-4 text-right font-mono">{formatFCFA(parseInt(p.total_gross ?? '0'))}</td>
                  <td className="p-4 text-right font-mono">{formatFCFA(parseInt(p.total_net ?? '0'))}</td>
                  <td className="p-4 text-right font-mono text-orange-600">{formatFCFA(parseInt(p.total_cnps ?? '0'))}</td>
                  <td className="p-4 text-right font-mono text-blue-600">{formatFCFA(parseInt(p.total_its ?? '0'))}</td>
                  <td className="p-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      p.status === 'closed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                    }`}>
                      {p.status === 'closed' ? 'Clôturée' : 'Ouverte'}
                    </span>
                  </td>
                </tr>
              ))}
              {periods.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-muted-foreground">
                    <Calculator className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    Aucune période de paie
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
