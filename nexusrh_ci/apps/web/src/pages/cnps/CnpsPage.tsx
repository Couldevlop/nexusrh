import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { api, formatFCFA } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { FileText, Download, Loader2, Send, ShieldCheck, AlertTriangle, CheckCircle, XCircle, ClipboardList, Building2, RefreshCw } from 'lucide-react'

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
  const { t } = useTranslation('cnps')
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
  // CNP-004/005 — DISA annuelle (génération + export CSV)
  const [disaYear, setDisaYear] = useState(currentYear)
  const [disaLoading, setDisaLoading] = useState<'generate' | 'csv' | null>(null)
  const [disaMsg, setDisaMsg] = useState<string | null>(null)

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

  // CNP-004 — génère la DISA annuelle (cumuls 12 mois par employé)
  const handleDisaGenerate = async () => {
    setDisaLoading('generate'); setDisaMsg(null)
    try {
      const res = await api.post('/cnps/disa/generate',
        hasSubsidiaries && legalEntityId ? { year: disaYear, legalEntityId } : { year: disaYear })
      const n = (res.data as { data?: { employeesCount?: number } })?.data?.employeesCount
      setDisaMsg(t('disa.generated', { count: n ?? 0, year: disaYear, defaultValue: `DISA ${disaYear} générée (${n ?? 0} salariés).` }))
    } catch (e) {
      setDisaMsg((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('disa.error', 'Échec de la génération DISA.'))
    } finally { setDisaLoading(null) }
  }
  // CNP-005 — export DISA CSV
  const handleDisaExport = async () => {
    setDisaLoading('csv')
    try {
      const res = await api.get(`/cnps/disa/${disaYear}/export`, { responseType: 'blob' })
      const blobUrl = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = blobUrl; a.download = `DISA_${disaYear}_CNPS.csv`; a.click()
      URL.revokeObjectURL(blobUrl)
    } catch (e) {
      setDisaMsg((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('disa.exportError', 'Aucune DISA pour cette année — générez-la d\'abord.'))
    } finally { setDisaLoading(null) }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('page.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t('page.subtitle')}
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
              <p className="font-bold text-base">{t('rns.title')}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                <Trans
                  i18nKey="rns.intro"
                  ns="cnps"
                  components={{
                    code: <span className="font-mono font-semibold" />,
                    strong: <span className="font-semibold" />,
                    link: <a href="https://ecnps.ci" target="_blank" rel="noreferrer" className="underline text-primary hover:opacity-80" />,
                  }}
                />
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
              {t('rns.downloadPdf')}
            </button>

            <button
              onClick={() => void handleRnsDownload('csv')}
              disabled={rnsLoading !== null}
              className="flex items-center gap-2 rounded-lg border border-primary bg-background px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/5 disabled:opacity-50 transition-colors"
            >
              {rnsLoading === 'csv'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Download className="h-4 w-4" />}
              {t('rns.exportCsv')}
            </button>
          </div>
        </div>

        {/* Rappel réglementaire */}
        <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-700">
            <Trans i18nKey="rns.deadlineNotice" ns="cnps" components={{ strong: <strong /> }} />
          </p>
        </div>
      </div>

      {/* ── DISA annuelle (CNP-004/005) ───────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2.5 shrink-0">
              <ClipboardList className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="font-bold text-base">{t('disa.title', 'DISA — Déclaration Individuelle des Salaires Annuels')}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('disa.intro', 'Déclaration annuelle (Loi 99-477) : cumuls salaire brut, cotisations CNPS et ITS par salarié, à déposer en janvier N+1 (CNPS + DGI).')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select value={disaYear} onChange={e => setDisaYear(parseInt(e.target.value))}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm font-semibold focus:ring-2 focus:ring-ring outline-none">
              {[currentYear, currentYear - 1, currentYear - 2].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={() => void handleDisaGenerate()} disabled={disaLoading !== null}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {disaLoading === 'generate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('disa.generate', 'Générer la DISA')}
            </button>
            <button onClick={() => void handleDisaExport()} disabled={disaLoading !== null}
              className="flex items-center gap-2 rounded-lg border border-primary bg-background px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/5 disabled:opacity-50">
              {disaLoading === 'csv' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {t('disa.exportCsv', 'Exporter (CSV)')}
            </button>
          </div>
        </div>
        {disaMsg && <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{disaMsg}</p>}
      </div>

      {/* Récapitulatif annuel */}
      {totals && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[
            { label: t('summary.grossPayroll'), value: formatFCFA(totals['gross'] ?? 0) },
            { label: t('summary.totalEmployeeCnps'), value: formatFCFA(totals['cnpsSal'] ?? 0) },
            { label: t('summary.totalEmployerCnps'), value: formatFCFA(totals['cnpsPat'] ?? 0) },
            { label: t('summary.totalIts'), value: formatFCFA(totals['its'] ?? 0) },
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
          <ShieldCheck className="h-4 w-4" /> {t('validator.title')}
        </h2>
        <p className="text-xs text-muted-foreground mb-4">
          {t('validator.subtitle')}
        </p>

        <div className="flex items-end gap-3 flex-wrap mb-4">
          <div>
            <label className="text-sm font-medium mb-1 block">{t('validator.year')}</label>
            <select value={year} onChange={e => { setYear(parseInt(e.target.value)); setValidation(null) }}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
              {[currentYear, currentYear - 1, currentYear - 2].map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">{t('validator.quarter')}</label>
            <select value={quarter} onChange={e => { setQuarter(parseInt(e.target.value)); setValidation(null) }}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
              <option value={1}>{t('validator.quarterOptions.q1')}</option>
              <option value={2}>{t('validator.quarterOptions.q2')}</option>
              <option value={3}>{t('validator.quarterOptions.q3')}</option>
              <option value={4}>{t('validator.quarterOptions.q4')}</option>
            </select>
          </div>

          {hasSubsidiaries && (
            <div>
              <label className="text-sm font-medium mb-1 flex items-center gap-1">
                <Building2 className="h-3 w-3" /> {t('validator.subsidiary')} <span className="text-red-500">*</span>
              </label>
              <select
                value={legalEntityId}
                onChange={e => { setLegalEntityId(e.target.value); setValidation(null) }}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none min-w-[220px]"
              >
                <option value="">{t('validator.chooseSubsidiary')}</option>
                {legalEntities.map(le => (
                  <option key={le.id} value={le.id}>
                    {le.name}{le.cnps_number ? ` ${t('validator.subsidiaryCnps', { number: le.cnps_number })}` : ''}
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
            {t('validator.validateData')}
          </button>
          <button
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending || (validation !== null && !validation.valid) || (hasSubsidiaries && !legalEntityId)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {generateMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('validator.generateDeclaration')}
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
                {validation.employerCnps ? t('validator.employerCnpsOk', { number: validation.employerCnps }) : t('validator.employerCnpsMissing')}
              </span>
              <span className="text-gray-600">{t('validator.payslipsFound', { count: validation.totalPayslips })}</span>
            </div>

            {/* Erreurs bloquantes */}
            {validation.errors.filter(e => e.severity === 'blocking').length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-red-700 flex items-center gap-1">
                  <XCircle className="h-3.5 w-3.5" /> {t('validator.blockers', { count: validation.errors.filter(e => e.severity === 'blocking').length })}
                </p>
                {validation.errors.filter(e => e.severity === 'blocking').slice(0, 8).map((e, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-red-700 bg-red-100 rounded px-2 py-1">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>{e.employeeName ? <strong>{e.employeeName} — </strong> : null}{e.message}</span>
                  </div>
                ))}
                {validation.errors.filter(e => e.severity === 'blocking').length > 8 && (
                  <p className="text-xs text-red-600">
                    {t('validator.moreEmployees', { count: validation.errors.filter(e => e.severity === 'blocking').length - 8 })}
                  </p>
                )}
              </div>
            )}

            {/* Avertissements */}
            {validation.warnings.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-amber-700">{t('validator.warnings', { count: validation.warnings.length })}</p>
                {validation.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-700">⚠ {w.message}</p>
                ))}
              </div>
            )}
          </div>
        )}

        {generateMut.isSuccess && (
          <p className="mt-2 text-sm text-green-600 flex items-center gap-1">
            <CheckCircle className="h-4 w-4" /> {t('validator.generateSuccess')}
          </p>
        )}
        {generateMut.isError && (
          <p className="mt-2 text-sm text-red-600">
            {(generateMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('validator.generateError')}
          </p>
        )}
      </div>

      {/* Liste des déclarations */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-6 py-4 flex items-center justify-between">
          <h2 className="font-semibold">{t('declarations.title', { year })}</h2>
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
                <th className="p-4">{t('declarations.quarterColumn')}</th>
                <th className="p-4">{t('declarations.monthsCovered')}</th>
                <th className="p-4 text-right">{t('declarations.grossPayroll')}</th>
                <th className="p-4 text-right">{t('declarations.totalCnps')}</th>
                <th className="p-4 text-center">{t('declarations.employees')}</th>
                <th className="p-4">{t('declarations.status')}</th>
                <th className="p-4">{t('declarations.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {decls.map(d => (
                <tr key={d.id} className="hover:bg-muted/30">
                  <td className="p-4 font-medium">{t('declarations.quarterCell', { quarter: d.quarter, year: d.year })}</td>
                  <td className="p-4 text-muted-foreground text-xs">{d.months?.join(', ')}</td>
                  <td className="p-4 text-right font-mono">{formatFCFA(parseInt(d.masse_salariale ?? '0'))}</td>
                  <td className="p-4 text-right font-mono text-orange-600">{formatFCFA(parseInt(d.total_cotisations ?? '0'))}</td>
                  <td className="p-4 text-center">{d.employees_count}</td>
                  <td className="p-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      d.status === 'submitted' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                    }`}>
                      {d.status === 'submitted' ? t('declarations.statusSubmitted') : t('declarations.statusDraft')}
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
                          <Send className="h-3 w-3" /> {t('declarations.submit')}
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
                    {t('declarations.empty', { year })}
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
