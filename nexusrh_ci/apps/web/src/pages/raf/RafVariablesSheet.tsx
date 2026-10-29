import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { confirmDialog } from '@/components/shared/ConfirmDialog'
import { AlertTriangle, CheckCircle2, Loader2, Save, Send, CircleSlash, ListChecks } from 'lucide-react'

/**
 * Feuille de variables d'une période-filiale (une ligne par salarié payé) +
 * contrôle obligatoire avant soumission :
 *   - dossiers salariés complets (situation familiale, enfants, n° sécurité
 *     sociale, mode de paiement + coordonnée, salaire ≥ SMIG du pays) ;
 *   - chaque ligne validée explicitement (« variables saisies » / « aucune
 *     variable ce mois ») ; toute modification invalide la validation.
 * Le bouton Soumettre reste désactivé tant que l'API ne renvoie pas ready=true
 * (l'API refuse de toute façon la soumission — contrôle serveur identique).
 */

type MissingCode = 'marital_status' | 'children_count' | 'cnps_number' | 'payment_method' | 'mobile_money_phone' | 'iban' | 'below_smig'

interface SheetRow {
  id: string
  name: string
  missing: MissingCode[]
  values: Record<string, number>
  validation: { mode: 'entered' | 'none'; validatedAt: string | null; valid: boolean } | null
  variablesValidated: boolean
}

interface SheetCode { code: string; label: string; unit: 'fcfa' | 'days' }

interface SheetData {
  period: { id: string; month: string; status: string; legislationPackCode: string }
  codes: SheetCode[]
  editable: boolean
  rows: SheetRow[]
  readiness: {
    smig: number; totalEmployees: number; validatedCount: number; incompleteCount: number
    dataComplete: boolean; variablesValidated: boolean; ready: boolean
  }
}

// Rôles autorisés sur la fiche salarié (/employees/:id) — le RAF site n'y a pas accès
const EMPLOYEE_PAGE_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly']

function apiError(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: unknown } } } | null
  const msg = e?.response?.data?.error
  return typeof msg === 'string' && msg.trim() ? msg : fallback
}

type Draft = Record<string, string>

function toDraft(values: Record<string, number>, codes: SheetCode[]): Draft {
  const d: Draft = {}
  for (const c of codes) d[c.code] = values[c.code] ? String(values[c.code]) : ''
  return d
}

/** Brouillon → valeurs entières (FCFA ou jours) ; null si une saisie est invalide. */
function parseDraft(draft: Draft, codes: SheetCode[]): Record<string, number> | null {
  const out: Record<string, number> = {}
  for (const c of codes) {
    const raw = (draft[c.code] ?? '').replace(/\s/g, '')
    if (raw === '') { out[c.code] = 0; continue }
    if (!/^\d+$/.test(raw)) return null
    const n = parseInt(raw, 10)
    if (c.unit === 'days' && n > 31) return null
    out[c.code] = n
  }
  return out
}

export default function RafVariablesSheet({ periodId, onSubmitted }: { periodId: string; onSubmitted?: () => void }) {
  const { t } = useTranslation('raf')
  const qc = useQueryClient()
  const role = useAuthStore(s => s.user?.role)
  const canOpenEmployee = !!role && EMPLOYEE_PAGE_ROLES.includes(role)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [actionError, setActionError] = useState<string | null>(null)

  const queryKey = ['raf-variables', periodId]
  const { data, isLoading, error } = useQuery<{ data: SheetData }>({
    queryKey,
    queryFn: () => api.get(`/payroll-workflow/periods/${periodId}/variables`).then(r => r.data),
  })
  const sheet = data?.data

  // (Ré)initialise les brouillons à partir des valeurs serveur
  useEffect(() => {
    if (!sheet) return
    const next: Record<string, Draft> = {}
    for (const r of sheet.rows) next[r.id] = toDraft(r.values, sheet.codes)
    setDrafts(next)
  }, [sheet])

  const refresh = () => qc.invalidateQueries({ queryKey })

  const saveMut = useMutation({
    mutationFn: ({ employeeId, values }: { employeeId: string; values: Record<string, number> }) =>
      api.put(`/payroll-workflow/periods/${periodId}/variables/${employeeId}`, { values }),
    onSuccess: (_d, v) => { setRowError(e => ({ ...e, [v.employeeId]: '' })); refresh() },
    onError: (err, v) => setRowError(e => ({ ...e, [v.employeeId]: apiError(err, t('sheet.saveError')) })),
  })

  const validateMut = useMutation({
    mutationFn: ({ employeeId, mode }: { employeeId: string; mode: 'entered' | 'none' }) =>
      api.post(`/payroll-workflow/periods/${periodId}/variables/${employeeId}/validate`, { mode }),
    onSuccess: (_d, v) => { setRowError(e => ({ ...e, [v.employeeId]: '' })); refresh() },
    onError: (err, v) => setRowError(e => ({ ...e, [v.employeeId]: apiError(err, t('sheet.validateError')) })),
  })

  const submitMut = useMutation({
    mutationFn: () => api.post(`/payroll-workflow/periods/${periodId}/submit-by-raf`),
    onSuccess: () => { setActionError(null); refresh(); onSubmitted?.() },
    onError: (err) => { setActionError(apiError(err, t('submitError'))); refresh() },
  })

  const incomplete = useMemo(() => (sheet?.rows ?? []).filter(r => r.missing.length > 0), [sheet])

  if (isLoading) {
    return <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('loading')}</div>
  }
  if (error || !sheet) {
    return <div role="alert" className="m-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{apiError(error, t('sheet.loadError'))}</div>
  }

  const { readiness, codes, editable } = sheet
  const isDirty = (row: SheetRow): boolean => {
    const parsed = parseDraft(drafts[row.id] ?? {}, codes)
    if (!parsed) return true
    return codes.some(c => (parsed[c.code] ?? 0) !== (row.values[c.code] ?? 0))
  }

  return (
    <div className="space-y-4 p-4">
      {/* Compteur + état global */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 font-medium">
          <ListChecks className="h-4 w-4" />
          {t('sheet.validatedCounter', { validated: readiness.validatedCount, total: readiness.totalEmployees })}
        </span>
        {readiness.ready ? (
          <span className="inline-flex items-center gap-1 text-green-700"><CheckCircle2 className="h-4 w-4" />{t('sheet.ready')}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="h-4 w-4" />{t('sheet.notReady')}</span>
        )}
        <span className="text-xs text-muted-foreground">{t('sheet.smigHint', { smig: readiness.smig, pack: sheet.period.legislationPackCode })}</span>
      </div>

      {/* Dossiers incomplets */}
      {incomplete.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">{t('sheet.incompleteTitle', { count: incomplete.length })}</p>
          {!canOpenEmployee && <p className="mt-0.5 text-xs">{t('sheet.incompleteRafHint')}</p>}
          <ul className="mt-2 space-y-1">
            {incomplete.map(r => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
                {canOpenEmployee
                  ? <Link to={`/employees/${r.id}`} className="font-medium underline underline-offset-2 hover:opacity-80">{r.name}</Link>
                  : <span className="font-medium">{r.name}</span>}
                <span className="text-xs">— {r.missing.map(m => t(`missing.${m}`, { smig: readiness.smig })).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Feuille de variables */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[960px] text-xs">
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th className="px-3 py-2 font-semibold">{t('sheet.colEmployee')}</th>
              {codes.map(c => (
                <th key={c.code} className="px-2 py-2 text-right font-semibold" title={c.label}>
                  {t(`codes.${c.code}`, { defaultValue: c.label })}
                  <span className="block font-normal text-muted-foreground">{c.unit === 'days' ? t('sheet.unitDays') : t('sheet.unitFcfa')}</span>
                </th>
              ))}
              <th className="px-3 py-2 font-semibold">{t('sheet.colValidation')}</th>
              <th className="px-3 py-2 text-right font-semibold">{t('colAction')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sheet.rows.length === 0 && (
              <tr><td colSpan={codes.length + 3} className="px-3 py-6 text-center text-muted-foreground">{t('sheet.noEmployees')}</td></tr>
            )}
            {sheet.rows.map(row => {
              const draft = drafts[row.id] ?? {}
              const dirty = isDirty(row)
              const busy = (saveMut.isPending && saveMut.variables?.employeeId === row.id)
                || (validateMut.isPending && validateMut.variables?.employeeId === row.id)
              const hasValues = Object.values(row.values).some(v => v !== 0)
              return (
                <tr key={row.id} className="align-top hover:bg-muted/20">
                  <td className="px-3 py-2 font-medium">
                    {row.name}
                    {row.missing.length > 0 && <AlertTriangle className="ml-1 inline h-3.5 w-3.5 text-amber-600" aria-label={t('sheet.incompleteBadge')} />}
                    {rowError[row.id] && <p className="mt-1 max-w-[220px] text-[11px] font-normal text-destructive">{rowError[row.id]}</p>}
                  </td>
                  {codes.map(c => (
                    <td key={c.code} className="px-1 py-1.5">
                      <input
                        type="text" inputMode="numeric"
                        aria-label={`${row.name} — ${t(`codes.${c.code}`, { defaultValue: c.label })}`}
                        disabled={!editable || busy}
                        value={draft[c.code] ?? ''}
                        onChange={e => setDrafts(d => ({ ...d, [row.id]: { ...(d[row.id] ?? {}), [c.code]: e.target.value } }))}
                        className="w-full min-w-[72px] rounded border border-input bg-background px-2 py-1 text-right tabular-nums disabled:opacity-60"
                      />
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    {row.variablesValidated ? (
                      <span className="inline-flex items-center gap-1 text-green-700">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {row.validation?.mode === 'none' ? t('sheet.validatedNone') : t('sheet.validatedEntered')}
                      </span>
                    ) : row.validation ? (
                      <span className="text-amber-700">{t('sheet.revalidate')}</span>
                    ) : (
                      <span className="text-muted-foreground">{t('sheet.toValidate')}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {editable && (
                      <div className="flex flex-col items-end gap-1">
                        {dirty ? (
                          <button
                            type="button" disabled={busy}
                            onClick={() => {
                              const values = parseDraft(draft, codes)
                              if (!values) { setRowError(e => ({ ...e, [row.id]: t('sheet.invalidValues') })); return }
                              saveMut.mutate({ employeeId: row.id, values })
                            }}
                            className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                          >
                            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}{t('sheet.save')}
                          </button>
                        ) : !row.variablesValidated && (
                          hasValues ? (
                            <button
                              type="button" disabled={busy}
                              onClick={() => validateMut.mutate({ employeeId: row.id, mode: 'entered' })}
                              className="inline-flex items-center gap-1 rounded border border-green-300 bg-green-50 px-2 py-1 font-semibold text-green-800 hover:bg-green-100 disabled:opacity-50"
                            >
                              <CheckCircle2 className="h-3 w-3" />{t('sheet.validateEntered')}
                            </button>
                          ) : (
                            <button
                              type="button" disabled={busy}
                              onClick={() => validateMut.mutate({ employeeId: row.id, mode: 'none' })}
                              className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-1 font-semibold hover:bg-muted disabled:opacity-50"
                            >
                              <CircleSlash className="h-3 w-3" />{t('sheet.validateNone')}
                            </button>
                          )
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Soumission */}
      {editable && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {!readiness.ready && <span className="text-xs text-muted-foreground">{t('sheet.submitDisabledHint')}</span>}
          <button
            type="button"
            disabled={!readiness.ready || submitMut.isPending}
            onClick={async () => {
              if (await confirmDialog({ message: t('submitConfirm', { month: sheet.period.month }), danger: false })) {
                submitMut.mutate()
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {t('submit')}
          </button>
        </div>
      )}
      {actionError && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{actionError}</div>
      )}
    </div>
  )
}
