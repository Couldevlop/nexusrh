import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, formatFCFA } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { FileText, Download, Loader2, Send, ShieldCheck, AlertTriangle, CheckCircle, XCircle, ClipboardList, Building2 } from 'lucide-react'

interface LegalEntity { id: string; name: string; city?: string | null; cnps_number?: string | null }

interface CnpsDeclaration {
  id: string; year: number; quarter: number; months: string[]
  total_cotisations_salariales: string; total_cotisations_patronales: string
  total_cotisations: string; masse_salariale: string; employees_count: number
  status: string; submitted_at: string | null
}

interface ValidationIssue {
  code: string
  severity: 'blocking' | 'warning'
  message: string
  employeeId?: string
  employeeName?: string
}

interface ValidationResult {
  valid: boolean
  year: number; quarter: number
  employerCnps: string | null
  totalPayslips: number
  errors: ValidationIssue[]
  warnings: Array<{ code: string; message: string }>
  summary: { blocking: number; warnings: number; message: string }
}

export default function CnpsPage() {
  const queryClient = useQueryClient()
  const tenantConfig = useAuthStore(s => s.tenantConfig)
  const hasSubsidiaries = tenantConfig?.hasSubsidiaries === true

  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const [quarter, setQuarter] = useState<number>(Math.ceil((new Date().getMonth() + 1) / 3))
  const [legalEntityId, setLegalEntityId] = useState<string>('')
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [validating, setValidating] = useState(false)
  const [rnsYear, setRnsYear] = useState(currentYear)
  const [rnsLoading, setRnsLoading] = useState<'pdf' | 'csv' | null>(null)

  // Charge les filiales SEULEMENT en multi-filiales (cf. Palier 3)
  const { data: entitiesData } = useQuery<{ data: LegalEntity[] }>({
    queryKey: ['legal-entities-for-cnps'],
    queryFn: () => api.get('/settings/legal-entities').then(r => r.data),
    enabled: hasSubsidiaries,
  })
  const legalEntities = entitiesData?.data ?? []

  const { data: declsData, isLoading } = useQuery<{ data: CnpsDeclaration[] }>({
    queryKey: ['cnps-declarations', year],
    queryFn: () => api.get(`/cnps/declarations?year=${year}`).then(r => r.data),
  })

  const { data: summaryData } = useQuery<{ data: unknown[]; totals: Record<string, number>; year: number }>({
    queryKey: ['cnps-summary', year],
    queryFn: () => api.get(`/cnps/summary?year=${year}`).then(r => r.data),
  })

  const generateMut = useMutation({
    mutationFn: () => api.post('/cnps/declarations/generate',
      hasSubsidiaries && legalEntityId
        ? { year, quarter, legalEntityId }
        : { year, quarter },
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cnps-declarations'] })
      setValidation(null)
    },
  })

  const submitMut = useMutation({
    mutationFn: (id: string) => api.post(`/cnps/declarations/${id}/submit`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cnps-declarations'] }),
  })

  const decls = declsData?.data ?? []
  const totals = summaryData?.totals

  const handleValidate = async () => {
    setValidating(true)
    try {
      const res = await api.get<ValidationResult>(`/cnps/validate/${year}/${quarter}`)
      setValidation(res.data)
    } catch {
      // ignore
    } finally {
      setValidating(false)
    }
  }

  const handleExport = async (id: string, qtr: number, format: 'csv' | 'neva' = 'csv') => {
    const url = format === 'neva' ? `/cnps/declarations/${id}/neva` : `/cnps/declarations/${id}/export`
    const res = await api.get(url, { responseType: 'blob' })
    const blobUrl = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = format === 'neva' ? `NEVA_CNPS_${year}_T${qtr}.xml` : `CNPS_${year}_T${qtr}.csv`
    a.click()
    URL.revokeObjectURL(blobUrl)
  }

  const handleRnsDownload = async (format: 'pdf' | 'csv') => {
    setRnsLoading(format)
    try {
      const res = await api.get(
        format === 'pdf' ? `/cnps/rns/${rnsYear}/pdf` : `/cnps/rns/${rnsYear}/export`,
        { responseType: 'blob' }
      )
      const blobUrl = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = format === 'pdf'
        ? `RNS_CNPS_${rnsYear}_EN-GDAV-06.pdf`
        : `RNS_CNPS_${rnsYear}_eCNPS.csv`
      a.click()
      URL.revokeObjectURL(blobUrl)
    } finally {
      setRnsLoading(null)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">CNPS & DISA</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Déclarations trimestrielles e-CNPS · DISA annuelle (loi 99-477)
        </p>
      </div>

      {/* ── Relevé Nominatif des Salaires ─────────────────────────────────── */}
      <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2.5 shrink-0">
              <ClipboardList className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="font-bold text-base">Relevé Nominatif des Salaires</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Formulaire officiel CNPS <span className="font-mono font-semibold">EN-GDAV-06 v03</span> — pré-rempli avec vos données de paie.
                À déposer sur <span className="font-semibold">e-CNPS</span> (
                <a href="https://ecnps.ci" target="_blank" rel="noreferrer"
                  className="underline text-primary hover:opacity-80">ecnps.ci</a>
                ) avant le <span className="font-semibold">15 du mois M+1</span>.
              </p>
            </div>
          </div>

          {/* Sélecteur année + boutons */}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={rnsYear}
              onChange={e => setRnsYear(parseInt(e.target.value))}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm font-semibold focus:ring-2 focus:ring-ring outline-none"
            >
              {[currentYear, currentYear - 1, currentYear - 2].map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>

            <button
              onClick={() => void handleRnsDownload('pdf')}
              disabled={rnsLoading !== null}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {rnsLoading === 'pdf'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Download className="h-4 w-4" />}
              Télécharger PDF
            </button>

            <button
              onClick={() => void handleRnsDownload('csv')}
              disabled={rnsLoading !== null}
              className="flex items-center gap-2 rounded-lg border border-primary bg-background px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/5 disabled:opacity-50 transition-colors"
            >
              {rnsLoading === 'csv'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Download className="h-4 w-4" />}
              Export CSV e-CNPS
            </button>
          </div>
        </div>

        {/* Rappel réglementaire */}
        <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-700">
            <strong>Délai légal :</strong> dépôt e-CNPS avant le <strong>15 du mois suivant</strong> la période déclarée
            (entreprises ≥ 50 salariés). Sanction : pénalités de retard CNPS + intérêts moratoires.
          </p>
        </div>
      </div>

      {/* Récapitulatif annuel */}
      {totals && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[
            { label: 'Masse salariale', value: formatFCFA(totals['gross'] ?? 0) },
            { label: 'CNPS salarial total', value: formatFCFA(totals['cnpsSal'] ?? 0) },
            { label: 'CNPS patronal total', value: formatFCFA(totals['cnpsPat'] ?? 0) },
            { label: 'ITS total', value: formatFCFA(totals['its'] ?? 0) },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-sm font-bold mt-1">{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Validateur pré-DSN */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-1 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> Validateur pré-DSN
        </h2>
        <p className="text-xs text-muted-foreground mb-4">
          Contrôle d'intégrité avant soumission : CNPS employeur, NNI, matricules, SMIG. Bloque l'envoi si données critiques manquantes.
        </p>

        <div className="flex items-end gap-3 flex-wrap mb-4">
          <div>
            <label className="text-sm font-medium mb-1 block">Année</label>
            <select value={year} onChange={e => { setYear(parseInt(e.target.value)); setValidation(null) }}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
              {[currentYear, currentYear - 1, currentYear - 2].map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Trimestre</label>
            <select value={quarter} onChange={e => { setQuarter(parseInt(e.target.value)); setValidation(null) }}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
              <option value={1}>T1 (Jan–Mar)</option>
              <option value={2}>T2 (Avr–Juin)</option>
              <option value={3}>T3 (Juil–Sep)</option>
              <option value={4}>T4 (Oct–Déc)</option>
            </select>
          </div>

          {hasSubsidiaries && (
            <div>
              <label className="text-sm font-medium mb-1 flex items-center gap-1">
                <Building2 className="h-3 w-3" /> Filiale <span className="text-red-500">*</span>
              </label>
              <select
                value={legalEntityId}
                onChange={e => { setLegalEntityId(e.target.value); setValidation(null) }}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none min-w-[220px]"
              >
                <option value="">-- Choisir --</option>
                {legalEntities.map(le => (
                  <option key={le.id} value={le.id}>
                    {le.name}{le.cnps_number ? ` (CNPS ${le.cnps_number})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            onClick={handleValidate}
            disabled={validating}
            className="flex items-center gap-2 rounded-lg border border-primary px-4 py-2 text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-50">
            {validating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Valider les données
          </button>
          <button
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending || (validation !== null && !validation.valid) || (hasSubsidiaries && !legalEntityId)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {generateMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Générer la déclaration
          </button>
        </div>

        {/* Résultats de validation */}
        {validation && (
          <div className={`rounded-xl border p-4 space-y-3 ${validation.valid ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
            <div className="flex items-center gap-2">
              {validation.valid
                ? <CheckCircle className="h-5 w-5 text-green-600" />
                : <XCircle className="h-5 w-5 text-red-600" />}
              <p className={`text-sm font-semibold ${validation.valid ? 'text-green-800' : 'text-red-800'}`}>
                {validation.summary.message}
              </p>
            </div>

            {/* Info employeur */}
            <div className="text-xs flex gap-4">
              <span className={validation.employerCnps ? 'text-green-700' : 'text-red-700'}>
                {validation.employerCnps ? `✓ N° CNPS employeur : ${validation.employerCnps}` : '✗ N° CNPS employeur manquant'}
              </span>
              <span className="text-gray-600">{validation.totalPayslips} bulletin(s) trouvé(s)</span>
            </div>

            {/* Erreurs bloquantes */}
            {validation.errors.filter(e => e.severity === 'blocking').length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-red-700 flex items-center gap-1">
                  <XCircle className="h-3.5 w-3.5" /> Blocages ({validation.errors.filter(e => e.severity === 'blocking').length})
                </p>
                {validation.errors.filter(e => e.severity === 'blocking').slice(0, 8).map((e, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-red-700 bg-red-100 rounded px-2 py-1">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>{e.employeeName ? <strong>{e.employeeName} — </strong> : null}{e.message}</span>
                  </div>
                ))}
                {validation.errors.filter(e => e.severity === 'blocking').length > 8 && (
                  <p className="text-xs text-red-600">
                    + {validation.errors.filter(e => e.severity === 'blocking').length - 8} autre(s) employé(s) à corriger
                  </p>
                )}
              </div>
            )}

            {/* Avertissements */}
            {validation.warnings.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-amber-700">Avertissements ({validation.warnings.length})</p>
                {validation.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-700">⚠ {w.message}</p>
                ))}
              </div>
            )}
          </div>
        )}

        {generateMut.isSuccess && (
          <p className="mt-2 text-sm text-green-600 flex items-center gap-1">
            <CheckCircle className="h-4 w-4" /> Déclaration générée avec succès.
          </p>
        )}
        {generateMut.isError && (
          <p className="mt-2 text-sm text-red-600">
            {(generateMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Erreur de génération'}
          </p>
        )}
      </div>

      {/* Liste des déclarations */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-6 py-4 flex items-center justify-between">
          <h2 className="font-semibold">Déclarations {year}</h2>
          <select value={year} onChange={e => setYear(parseInt(e.target.value))}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
            {[currentYear, currentYear - 1, currentYear - 2].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="p-4">Trimestre</th>
                <th className="p-4">Mois couverts</th>
                <th className="p-4 text-right">Masse salariale</th>
                <th className="p-4 text-right">Total CNPS</th>
                <th className="p-4 text-center">Employés</th>
                <th className="p-4">Statut</th>
                <th className="p-4">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {decls.map(d => (
                <tr key={d.id} className="hover:bg-muted/30">
                  <td className="p-4 font-medium">T{d.quarter} {d.year}</td>
                  <td className="p-4 text-muted-foreground text-xs">{d.months?.join(', ')}</td>
                  <td className="p-4 text-right font-mono">{formatFCFA(parseInt(d.masse_salariale ?? '0'))}</td>
                  <td className="p-4 text-right font-mono text-orange-600">{formatFCFA(parseInt(d.total_cotisations ?? '0'))}</td>
                  <td className="p-4 text-center">{d.employees_count}</td>
                  <td className="p-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      d.status === 'submitted' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                    }`}>
                      {d.status === 'submitted' ? 'Soumise' : 'Brouillon'}
                    </span>
                  </td>
                  <td className="p-4">
                    <div className="flex gap-1.5 flex-wrap">
                      <button onClick={() => handleExport(d.id, d.quarter, 'csv')}
                        className="flex items-center gap-1 rounded-lg bg-muted px-2 py-1 text-xs font-medium hover:bg-accent">
                        <Download className="h-3 w-3" /> CSV
                      </button>
                      <button onClick={() => handleExport(d.id, d.quarter, 'neva')}
                        className="flex items-center gap-1 rounded-lg bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-200">
                        <Download className="h-3 w-3" /> NEVA
                      </button>
                      {d.status !== 'submitted' && (
                        <button
                          onClick={() => submitMut.mutate(d.id)}
                          disabled={submitMut.isPending}
                          className="flex items-center gap-1 rounded-lg bg-green-100 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-200 disabled:opacity-50">
                          <Send className="h-3 w-3" /> Soumettre
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {decls.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground">
                    <FileText className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    Aucune déclaration pour {year}
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
