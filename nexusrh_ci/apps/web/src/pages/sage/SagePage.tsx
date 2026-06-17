import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { FileSpreadsheet, Download, Users, ListChecks, Wallet, CheckCircle2, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const SEPARATORS = ['semicolon', 'comma', 'tab', 'pipe'] as const
const MATRICULE_SOURCES = ['employee_number', 'id'] as const

interface SageConfig { enabled: boolean; separator: string; include_header: boolean; matricule_source: string }
type ExportKind = 'employees' | 'variable_elements' | 'payroll'

async function downloadCsv(url: string, filename: string): Promise<void> {
  const res = await api.get(url, { responseType: 'blob' })
  const objUrl = URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = objUrl; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(objUrl)
}

export default function SagePage() {
  const { t } = useTranslation('sage')
  const qc = useQueryClient()
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null)
  useEffect(() => {
    if (!flash) return undefined
    const id = setTimeout(() => setFlash(null), 4000)
    return () => clearTimeout(id)
  }, [flash])

  const cfgQ = useQuery({ queryKey: ['sage', 'config'], queryFn: async () => (await api.get('/sage/config')).data.data as SageConfig })
  const [cfg, setCfg] = useState<SageConfig | null>(null)
  useEffect(() => { if (cfgQ.data) setCfg(cfgQ.data) }, [cfgQ.data])

  const save = useMutation({
    mutationFn: async () => {
      if (!cfg) return
      await api.put('/sage/config', { enabled: cfg.enabled, separator: cfg.separator, includeHeader: cfg.include_header, matriculeSource: cfg.matricule_source })
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sage', 'config'] }); setFlash({ ok: true, msg: t('saved') }) },
    onError: () => setFlash({ ok: false, msg: t('saveError') }),
  })

  const [period, setPeriod] = useState('')
  const [busy, setBusy] = useState<ExportKind | null>(null)
  async function runExport(kind: ExportKind) {
    if ((kind === 'variable_elements' || kind === 'payroll') && !/^\d{4}-\d{2}$/.test(period)) {
      setFlash({ ok: false, msg: t('exports.periodRequired') }); return
    }
    setBusy(kind)
    try {
      if (kind === 'employees') await downloadCsv('/sage/export/employees.csv', 'sage_employees.csv')
      else if (kind === 'variable_elements') await downloadCsv(`/sage/export/variable-elements.csv?period=${period}`, `sage_variable_elements_${period}.csv`)
      else await downloadCsv(`/sage/export/payroll.csv?period=${period}`, `sage_payroll_${period}.csv`)
    } catch { setFlash({ ok: false, msg: t('saveError') }) } finally { setBusy(null) }
  }

  const field = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm'
  const cards: Array<{ kind: ExportKind; icon: typeof Users; needsPeriod: boolean }> = [
    { kind: 'employees', icon: Users, needsPeriod: false },
    { kind: 'variable_elements', icon: ListChecks, needsPeriod: true },
    { kind: 'payroll', icon: Wallet, needsPeriod: true },
  ]

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><FileSpreadsheet className="h-5 w-5" /></div>
        <div>
          <h1 className="text-xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      {flash && (
        <div className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
          flash.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800')}>
          {flash.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />} {flash.msg}
        </div>
      )}

      {/* Configuration */}
      {cfg && (
        <div className="max-w-2xl space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('config.title')}</h2>
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} /> {t('config.enabled')}</label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('config.separator')}</label>
              <select value={cfg.separator} onChange={(e) => setCfg({ ...cfg, separator: e.target.value })} className={field}>
                {SEPARATORS.map((s) => <option key={s} value={s}>{t(`config.separators.${s}`)}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('config.matriculeSource')}</label>
              <select value={cfg.matricule_source} onChange={(e) => setCfg({ ...cfg, matricule_source: e.target.value })} className={field}>
                {MATRICULE_SOURCES.map((s) => <option key={s} value={s}>{t(`config.matriculeSources.${s}`)}</option>)}
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cfg.include_header} onChange={(e) => setCfg({ ...cfg, include_header: e.target.checked })} /> {t('config.includeHeader')}</label>
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{t('config.note')}</p>
          <div className="flex justify-end">
            <button type="button" disabled={save.isPending} onClick={() => save.mutate()} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">{save.isPending ? t('saving') : t('save')}</button>
          </div>
        </div>
      )}

      {/* Exports */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('exports.title')}</h2>
          <div>
            <label className="mr-2 text-xs text-muted-foreground">{t('exports.period')}</label>
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map(({ kind, icon: Icon, needsPeriod }) => (
            <div key={kind} className="flex flex-col rounded-xl border border-border bg-card p-4">
              <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-5 w-5" /></div>
              <p className="font-semibold">{t(`exports.${kind === 'variable_elements' ? 'variableElements' : kind}`)}</p>
              <p className="mb-3 flex-1 text-xs text-muted-foreground">{t(`exports.${kind === 'variable_elements' ? 'variableElementsDesc' : kind + 'Desc'}`)}</p>
              <button type="button" disabled={busy === kind || (needsPeriod && !period)} onClick={() => runExport(kind)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-50">
                <Download className="h-4 w-4" /> {busy === kind ? t('exports.downloading') : t('exports.download')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
