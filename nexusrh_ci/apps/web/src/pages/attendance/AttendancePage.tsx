import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Clock, Plus, Trash2, Pencil, RefreshCw, Zap, CheckCircle2, XCircle,
  LayoutDashboard, ListChecks, AlertTriangle, Settings as SettingsIcon, LogIn,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Tab = 'dashboard' | 'punches' | 'days' | 'warnings' | 'config'

/** Message d'erreur lisible depuis une réponse API — jamais un silence. */
function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: string } } } | undefined)?.response?.data
  if (data?.error) return data.error
  if (err instanceof Error && err.message) return err.message
  return fallback
}

interface EmployeeRow { id: string; first_name: string; last_name: string; employee_number: string | null }

interface DashboardData {
  lateDays: number; absentDays: number; activeWarnings: number
  pendingExplanations: number; sanctionDrafts: number; from: string; to: string
}

interface PunchRow {
  id: string; employee_id: string; raw_employee_ref: string | null; device_id: string | null
  punched_at: string; direction: string; source: string; created_at: string
}

interface DayRow {
  id: string; employee_id: string; work_date: string; first_in: string | null; last_out: string | null
  expected_start: string | null; late_minutes: number; status: string; justified_by: string | null; computed_at: string
}

interface WarningRow {
  id: string; employee_id: string; tier: string; trigger_reason: string; occurrence_dates: string[]
  status: string; employee_response: string | null; responded_at: string | null
  disciplinary_action_id: string | null; created_at: string
}

interface FieldMapping {
  recordsPath?: string; employeePath?: string; employeeMatchBy?: string
  timestampPath?: string; timestampFormat?: string
  directionPath?: string; directionInValue?: string; directionOutValue?: string
}

interface DeviceRow {
  id: string; name: string; base_url: string; auth_type: string; auth_header_name: string | null
  default_headers: Record<string, string> | null; field_mapping: FieldMapping | null
  poll_enabled: boolean; poll_interval_min: number; last_sync_at: string | null
  last_sync_status: string | null; is_active: boolean; created_at: string; has_secret: boolean
}

interface ScheduleRow {
  id: string; scope: string; scope_id: string | null; expected_start: string; tolerance_min: number
  expected_end: string | null; workdays: number[]; is_active: boolean; created_at: string; updated_at: string
}

interface ConfigData {
  lateMinutesTier1: number; occurrencesTier1: number; lateMinutesTier2: number; occurrencesTier2: number
  unjustifiedAbsenceOccurrences: number; warningsBeforeSanction: number; windowMode: string
  defaultExpectedStart: string; defaultToleranceMin: number; defaultWorkdays: number[]
}

const DAY_STATUS_STYLE: Record<string, string> = {
  present: 'bg-emerald-100 text-emerald-800',
  late: 'bg-amber-100 text-amber-800',
  absent_unjustified: 'bg-rose-100 text-rose-800',
  absent_justified: 'bg-sky-100 text-sky-800',
  off: 'bg-muted text-muted-foreground',
}
const WARNING_STATUS_STYLE: Record<string, string> = {
  active: 'bg-amber-100 text-amber-800',
  explained: 'bg-emerald-100 text-emerald-800',
  contested: 'bg-orange-100 text-orange-800',
  closed: 'bg-slate-200 text-slate-700',
}
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const
const AUTH_TYPES = ['none', 'bearer', 'basic', 'api_key'] as const

const FIELD = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm'

export default function AttendancePage() {
  const { t } = useTranslation('attendance')
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null)
  useEffect(() => {
    if (!flash) return undefined
    const id = setTimeout(() => setFlash(null), 5000)
    return () => clearTimeout(id)
  }, [flash])

  const employeesQ = useQuery({
    queryKey: ['employees', 'min'],
    queryFn: async () => (await api.get('/employees')).data.data as EmployeeRow[],
  })
  const employeeName = (id: string): string => {
    const e = (employeesQ.data ?? []).find((x) => x.id === id)
    return e ? `${e.first_name} ${e.last_name}` : id
  }

  // ── Tableau de bord ────────────────────────────────────────────────────
  const dashboardQ = useQuery({
    queryKey: ['attendance', 'dashboard'],
    enabled: tab === 'dashboard' || tab === 'warnings',
    queryFn: async () => (await api.get('/attendance/dashboard')).data.data as DashboardData,
  })

  // ── Pointages ──────────────────────────────────────────────────────────
  const punchesQ = useQuery({
    queryKey: ['attendance', 'punches'],
    enabled: tab === 'punches',
    queryFn: async () => (await api.get('/attendance/punches')).data.data as PunchRow[],
  })
  const [showPunchForm, setShowPunchForm] = useState(false)
  const [punchForm, setPunchForm] = useState({ employeeId: '', direction: 'in', punchedAt: '', reason: '' })
  const [punchError, setPunchError] = useState<string | null>(null)
  const createPunchMut = useMutation({
    mutationFn: async () => {
      await api.post('/attendance/punches', {
        employeeId: punchForm.employeeId,
        direction: punchForm.direction,
        punchedAt: new Date(punchForm.punchedAt).toISOString(),
        reason: punchForm.reason || undefined,
      })
    },
    onSuccess: () => {
      setShowPunchForm(false)
      setPunchForm({ employeeId: '', direction: 'in', punchedAt: '', reason: '' })
      setPunchError(null)
      void qc.invalidateQueries({ queryKey: ['attendance', 'punches'] })
    },
    onError: (err) => setPunchError(apiErrorMessage(err, t('punches.form.error'))),
  })
  const canSubmitPunch = punchForm.employeeId.length > 0 && punchForm.punchedAt.length > 0

  // ── Retards & absences ────────────────────────────────────────────────
  const daysQ = useQuery({
    queryKey: ['attendance', 'days'],
    enabled: tab === 'days',
    queryFn: async () => (await api.get('/attendance/days')).data.data as DayRow[],
  })

  // ── Avertissements ─────────────────────────────────────────────────────
  const warningsQ = useQuery({
    queryKey: ['attendance', 'warnings'],
    enabled: tab === 'warnings',
    queryFn: async () => (await api.get('/attendance/warnings')).data.data as WarningRow[],
  })
  const [warningError, setWarningError] = useState<string | null>(null)
  const warningStatusMut = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      await api.patch(`/attendance/warnings/${id}`, { status })
    },
    onSuccess: () => {
      setWarningError(null)
      void qc.invalidateQueries({ queryKey: ['attendance', 'warnings'] })
    },
    onError: (err) => setWarningError(apiErrorMessage(err, t('warnings.error'))),
  })

  // ── Configuration : moteur d'escalade ─────────────────────────────────
  const configQ = useQuery({
    queryKey: ['attendance', 'config'],
    enabled: tab === 'config',
    queryFn: async () => (await api.get('/attendance/config')).data.data as ConfigData,
  })
  const [configForm, setConfigForm] = useState<ConfigData | null>(null)
  useEffect(() => { if (configQ.data) setConfigForm(configQ.data) }, [configQ.data])
  const saveConfigMut = useMutation({
    mutationFn: async () => {
      if (!configForm) return
      await api.put('/attendance/config', configForm)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['attendance', 'config'] })
      setFlash({ ok: true, msg: t('config.saved') })
    },
    onError: (err) => setFlash({ ok: false, msg: apiErrorMessage(err, t('config.saveError')) }),
  })
  const toggleConfigWorkday = (d: number) => {
    setConfigForm((c) => c ? {
      ...c,
      defaultWorkdays: c.defaultWorkdays.includes(d)
        ? c.defaultWorkdays.filter((x) => x !== d)
        : [...c.defaultWorkdays, d].sort(),
    } : c)
  }

  // ── Configuration : badgeuses ─────────────────────────────────────────
  const devicesQ = useQuery({
    queryKey: ['attendance', 'devices'],
    enabled: tab === 'config',
    queryFn: async () => (await api.get('/attendance/devices')).data.data as DeviceRow[],
  })
  const emptyDeviceForm = {
    name: '', base_url: '', auth_type: 'none' as string, auth_secret: '', auth_header_name: '',
    field_mapping: '{}', poll_interval_min: 15, is_active: true,
  }
  const [showDeviceForm, setShowDeviceForm] = useState(false)
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)
  const [editingDeviceHasSecret, setEditingDeviceHasSecret] = useState(false)
  const [deviceForm, setDeviceForm] = useState(emptyDeviceForm)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [deviceTestResult, setDeviceTestResult] = useState<Record<string, { ok: boolean; count: number; error?: string }>>({})

  const resetDeviceForm = () => {
    setShowDeviceForm(false); setEditingDeviceId(null); setEditingDeviceHasSecret(false)
    setDeviceForm(emptyDeviceForm); setDeviceError(null)
  }
  const startEditDevice = (d: DeviceRow) => {
    setEditingDeviceId(d.id)
    setEditingDeviceHasSecret(d.has_secret)
    setDeviceForm({
      name: d.name, base_url: d.base_url, auth_type: d.auth_type,
      auth_secret: '', auth_header_name: d.auth_header_name ?? '',
      field_mapping: JSON.stringify(d.field_mapping ?? {}, null, 2),
      poll_interval_min: d.poll_interval_min, is_active: d.is_active,
    })
    setShowDeviceForm(true)
    setDeviceError(null)
  }
  const saveDeviceMut = useMutation({
    mutationFn: async () => {
      let mapping: FieldMapping
      try {
        mapping = JSON.parse(deviceForm.field_mapping.trim() || '{}') as FieldMapping
      } catch {
        throw new Error(t('config.devices.form.mappingInvalid'))
      }
      const payload = {
        name: deviceForm.name,
        base_url: deviceForm.base_url,
        auth_type: deviceForm.auth_type,
        ...(deviceForm.auth_secret ? { auth_secret: deviceForm.auth_secret } : {}),
        auth_header_name: deviceForm.auth_header_name || undefined,
        field_mapping: mapping,
        poll_interval_min: deviceForm.poll_interval_min,
        is_active: deviceForm.is_active,
      }
      if (editingDeviceId) await api.patch(`/attendance/devices/${editingDeviceId}`, payload)
      else await api.post('/attendance/devices', payload)
    },
    onSuccess: () => {
      resetDeviceForm()
      void qc.invalidateQueries({ queryKey: ['attendance', 'devices'] })
    },
    onError: (err) => setDeviceError(apiErrorMessage(err, t('config.devices.form.error'))),
  })
  const deleteDeviceMut = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/attendance/devices/${id}`) },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['attendance', 'devices'] }),
    onError: (err) => setDeviceError(apiErrorMessage(err, t('config.devices.form.error'))),
  })
  const testDeviceMut = useMutation({
    mutationFn: async (id: string) => ({
      id, result: (await api.post(`/attendance/devices/${id}/test`)).data.data as { ok: boolean; count: number; error?: string },
    }),
    onSuccess: ({ id, result }) => setDeviceTestResult((s) => ({ ...s, [id]: result })),
    onError: (err, id) => setDeviceTestResult((s) => ({ ...s, [id]: { ok: false, count: 0, error: apiErrorMessage(err, t('config.devices.testError')) } })),
  })
  const syncDeviceMut = useMutation({
    mutationFn: async (id: string) => { await api.post(`/attendance/devices/${id}/sync`) },
    onSuccess: () => setFlash({ ok: true, msg: t('config.devices.syncQueued') }),
    onError: (err) => setFlash({ ok: false, msg: apiErrorMessage(err, t('config.devices.syncError')) }),
  })

  // ── Configuration : horaires de référence ─────────────────────────────
  const schedulesQ = useQuery({
    queryKey: ['attendance', 'schedules'],
    enabled: tab === 'config',
    queryFn: async () => (await api.get('/attendance/schedules')).data.data as ScheduleRow[],
  })
  const emptyScheduleForm = {
    scope: 'tenant' as string, scope_id: '', expected_start: '08:00', expected_end: '',
    tolerance_min: 10, workdays: [1, 2, 3, 4, 5] as number[], is_active: true,
  }
  const [showScheduleForm, setShowScheduleForm] = useState(false)
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null)
  const [scheduleForm, setScheduleForm] = useState(emptyScheduleForm)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const resetScheduleForm = () => {
    setShowScheduleForm(false); setEditingScheduleId(null)
    setScheduleForm(emptyScheduleForm); setScheduleError(null)
  }
  const startEditSchedule = (s: ScheduleRow) => {
    setEditingScheduleId(s.id)
    setScheduleForm({
      scope: s.scope, scope_id: s.scope_id ?? '', expected_start: s.expected_start.slice(0, 5),
      expected_end: s.expected_end ? s.expected_end.slice(0, 5) : '', tolerance_min: s.tolerance_min,
      workdays: s.workdays, is_active: s.is_active,
    })
    setShowScheduleForm(true); setScheduleError(null)
  }
  const toggleScheduleWorkday = (d: number) => {
    setScheduleForm((f) => ({
      ...f,
      workdays: f.workdays.includes(d) ? f.workdays.filter((x) => x !== d) : [...f.workdays, d].sort(),
    }))
  }
  const saveScheduleMut = useMutation({
    mutationFn: async () => {
      const payload = {
        scope: scheduleForm.scope,
        scope_id: scheduleForm.scope !== 'tenant' ? (scheduleForm.scope_id || null) : undefined,
        expected_start: scheduleForm.expected_start,
        expected_end: scheduleForm.expected_end || null,
        tolerance_min: scheduleForm.tolerance_min,
        workdays: scheduleForm.workdays,
        is_active: scheduleForm.is_active,
      }
      if (editingScheduleId) await api.patch(`/attendance/schedules/${editingScheduleId}`, payload)
      else await api.post('/attendance/schedules', payload)
    },
    onSuccess: () => { resetScheduleForm(); void qc.invalidateQueries({ queryKey: ['attendance', 'schedules'] }) },
    onError: (err) => setScheduleError(apiErrorMessage(err, t('config.schedules.form.error'))),
  })
  const deleteScheduleMut = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/attendance/schedules/${id}`) },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['attendance', 'schedules'] }),
    onError: (err) => setScheduleError(apiErrorMessage(err, t('config.schedules.form.error'))),
  })

  const TabBtn = ({ value, label, icon: Icon }: { value: Tab; label: string; icon: React.ElementType }) => (
    <button type="button" onClick={() => setTab(value)}
      className={cn('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium',
        tab === value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent')}>
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Clock className="h-5 w-5" /></div>
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

      <div className="flex w-fit flex-wrap gap-1.5 rounded-xl border border-border bg-muted/40 p-1">
        <TabBtn value="dashboard" label={t('tabs.dashboard')} icon={LayoutDashboard} />
        <TabBtn value="punches" label={t('tabs.punches')} icon={LogIn} />
        <TabBtn value="days" label={t('tabs.days')} icon={ListChecks} />
        <TabBtn value="warnings" label={t('tabs.warnings')} icon={AlertTriangle} />
        <TabBtn value="config" label={t('tabs.config')} icon={SettingsIcon} />
      </div>

      {/* ── Tableau de bord ── */}
      {tab === 'dashboard' && (
        <div>
          {dashboardQ.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('dashboard.loading')}</p>}
          {dashboardQ.isError && <p className="py-10 text-center text-sm text-destructive">{t('dashboard.loadError')}</p>}
          {dashboardQ.data && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {([
                ['lateDays', dashboardQ.data.lateDays],
                ['absentDays', dashboardQ.data.absentDays],
                ['activeWarnings', dashboardQ.data.activeWarnings],
                ['pendingExplanations', dashboardQ.data.pendingExplanations],
                ['sanctionDrafts', dashboardQ.data.sanctionDrafts],
              ] as const).map(([key, value]) => (
                <div key={key} className="rounded-xl border border-border bg-card p-4">
                  <p className="text-2xl font-bold">{value}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t(`dashboard.${key}`)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Pointages ── */}
      {tab === 'punches' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button type="button" onClick={() => setShowPunchForm((s) => !s)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90">
              <Plus className="h-4 w-4" /> {t('punches.new')}
            </button>
          </div>

          {showPunchForm && (
            <div className="max-w-2xl rounded-xl border border-border bg-card p-4 space-y-3">
              <h2 className="text-sm font-semibold">{t('punches.form.title')}</h2>
              {punchError && <p className="text-sm text-destructive">{punchError}</p>}
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">{t('punches.form.employee')}</span>
                <select value={punchForm.employeeId} onChange={(e) => setPunchForm((f) => ({ ...f, employeeId: e.target.value }))} className={FIELD}>
                  <option value="">{t('punches.form.employeePlaceholder')}</option>
                  {(employeesQ.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                </select>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">{t('punches.form.direction')}</span>
                <select value={punchForm.direction} onChange={(e) => setPunchForm((f) => ({ ...f, direction: e.target.value }))} className={FIELD}>
                  <option value="in">{t('directions.in')}</option>
                  <option value="out">{t('directions.out')}</option>
                  <option value="unknown">{t('directions.unknown')}</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">{t('punches.form.punchedAt')}</span>
                <input type="datetime-local" value={punchForm.punchedAt} onChange={(e) => setPunchForm((f) => ({ ...f, punchedAt: e.target.value }))} className={FIELD} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">{t('punches.form.reason')}</span>
                <input type="text" value={punchForm.reason} placeholder={t('punches.form.reasonPlaceholder')}
                  onChange={(e) => setPunchForm((f) => ({ ...f, reason: e.target.value }))} className={FIELD} />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowPunchForm(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent">{t('punches.form.cancel')}</button>
                <button type="button" disabled={!canSubmitPunch || createPunchMut.isPending} onClick={() => createPunchMut.mutate()}
                  className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                  {createPunchMut.isPending ? t('punches.form.submitting') : t('punches.form.submit')}
                </button>
              </div>
            </div>
          )}

          {punchesQ.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('punches.loading')}</p>}
          {punchesQ.isError && <p className="py-10 text-center text-sm text-destructive">{t('punches.loadError')}</p>}
          {!punchesQ.isLoading && (punchesQ.data?.length ?? 0) === 0 && (
            <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('punches.empty')}</p>
          )}
          {(punchesQ.data?.length ?? 0) > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2">{t('punches.columns.employee')}</th>
                  <th className="px-3 py-2">{t('punches.columns.direction')}</th>
                  <th className="px-3 py-2">{t('punches.columns.punchedAt')}</th>
                  <th className="px-3 py-2">{t('punches.columns.source')}</th>
                </tr></thead>
                <tbody>
                  {(punchesQ.data ?? []).map((p) => (
                    <tr key={p.id} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2 font-medium">{employeeName(p.employee_id)}</td>
                      <td className="px-3 py-2">{t(`directions.${p.direction}`)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{new Date(p.punched_at).toLocaleString()}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{p.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Retards & absences ── */}
      {tab === 'days' && (
        <div>
          {daysQ.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('days.loading')}</p>}
          {daysQ.isError && <p className="py-10 text-center text-sm text-destructive">{t('days.loadError')}</p>}
          {!daysQ.isLoading && (daysQ.data?.length ?? 0) === 0 && (
            <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('days.empty')}</p>
          )}
          {(daysQ.data?.length ?? 0) > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2">{t('days.columns.employee')}</th>
                  <th className="px-3 py-2">{t('days.columns.date')}</th>
                  <th className="px-3 py-2">{t('days.columns.status')}</th>
                  <th className="px-3 py-2">{t('days.columns.lateMinutes')}</th>
                  <th className="px-3 py-2">{t('days.columns.firstIn')}</th>
                  <th className="px-3 py-2">{t('days.columns.lastOut')}</th>
                </tr></thead>
                <tbody>
                  {(daysQ.data ?? []).map((d) => (
                    <tr key={d.id} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2 font-medium">{employeeName(d.employee_id)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{d.work_date}</td>
                      <td className="px-3 py-2">
                        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', DAY_STATUS_STYLE[d.status] ?? 'bg-muted')}>
                          {t(`statuses.${d.status}`)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{d.late_minutes}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{d.first_in ? new Date(d.first_in).toLocaleTimeString() : '—'}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{d.last_out ? new Date(d.last_out).toLocaleTimeString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Avertissements ── */}
      {tab === 'warnings' && (
        <div className="space-y-4">
          {(dashboardQ.data?.sanctionDrafts ?? 0) > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t('warnings.sanctionDraftsBanner', { count: dashboardQ.data?.sanctionDrafts ?? 0 })}
            </div>
          )}
          {warningError && <p className="text-sm text-destructive">{warningError}</p>}

          {warningsQ.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('warnings.loading')}</p>}
          {warningsQ.isError && <p className="py-10 text-center text-sm text-destructive">{t('warnings.loadError')}</p>}
          {!warningsQ.isLoading && (warningsQ.data?.length ?? 0) === 0 && (
            <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('warnings.empty')}</p>
          )}
          {(warningsQ.data?.length ?? 0) > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2">{t('warnings.columns.employee')}</th>
                  <th className="px-3 py-2">{t('warnings.columns.tier')}</th>
                  <th className="px-3 py-2">{t('warnings.columns.reason')}</th>
                  <th className="px-3 py-2">{t('warnings.columns.dates')}</th>
                  <th className="px-3 py-2">{t('warnings.columns.status')}</th>
                  <th className="px-3 py-2">{t('warnings.columns.response')}</th>
                  <th className="px-3 py-2 text-right">{t('warnings.columns.actions')}</th>
                </tr></thead>
                <tbody>
                  {(warningsQ.data ?? []).map((w) => (
                    <tr key={w.id} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2 font-medium">{employeeName(w.employee_id)}</td>
                      <td className="px-3 py-2">{t(`warnings.tiers.${w.tier}`, { defaultValue: w.tier })}</td>
                      <td className="px-3 py-2 max-w-[16rem] truncate" title={w.trigger_reason}>{w.trigger_reason}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{w.occurrence_dates.join(', ')}</td>
                      <td className="px-3 py-2">
                        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', WARNING_STATUS_STYLE[w.status] ?? 'bg-muted')}>
                          {t(`warnings.statuses.${w.status}`, { defaultValue: w.status })}
                        </span>
                      </td>
                      <td className="px-3 py-2 max-w-[14rem] truncate text-xs text-muted-foreground" title={w.employee_response ?? ''}>
                        {w.employee_response ?? '—'}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1.5">
                          {w.status === 'active' && (
                            <button type="button" disabled={warningStatusMut.isPending}
                              onClick={() => warningStatusMut.mutate({ id: w.id, status: 'explained' })}
                              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50">
                              {t('warnings.actions.explain')}
                            </button>
                          )}
                          {w.status !== 'closed' && (
                            <button type="button" disabled={warningStatusMut.isPending}
                              onClick={() => warningStatusMut.mutate({ id: w.id, status: 'closed' })}
                              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50">
                              {t('warnings.actions.close')}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Configuration ── */}
      {tab === 'config' && (
        <div className="space-y-8">
          {/* Moteur d'escalade */}
          <section className="max-w-2xl space-y-3 rounded-xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">{t('config.escalade.title')}</h2>
            {configQ.isLoading && <p className="text-sm text-muted-foreground">{t('config.loading')}</p>}
            {configQ.isError && <p className="text-sm text-destructive">{t('config.loadError')}</p>}
            {configForm && (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('config.escalade.lateMinutesTier1')}</span>
                    <input type="number" min={0} value={configForm.lateMinutesTier1}
                      onChange={(e) => setConfigForm((c) => c ? { ...c, lateMinutesTier1: Number(e.target.value) } : c)} className={FIELD} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('config.escalade.occurrencesTier1')}</span>
                    <input type="number" min={1} value={configForm.occurrencesTier1}
                      onChange={(e) => setConfigForm((c) => c ? { ...c, occurrencesTier1: Number(e.target.value) } : c)} className={FIELD} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('config.escalade.lateMinutesTier2')}</span>
                    <input type="number" min={0} value={configForm.lateMinutesTier2}
                      onChange={(e) => setConfigForm((c) => c ? { ...c, lateMinutesTier2: Number(e.target.value) } : c)} className={FIELD} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('config.escalade.occurrencesTier2')}</span>
                    <input type="number" min={1} value={configForm.occurrencesTier2}
                      onChange={(e) => setConfigForm((c) => c ? { ...c, occurrencesTier2: Number(e.target.value) } : c)} className={FIELD} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('config.escalade.unjustifiedAbsenceOccurrences')}</span>
                    <input type="number" min={1} value={configForm.unjustifiedAbsenceOccurrences}
                      onChange={(e) => setConfigForm((c) => c ? { ...c, unjustifiedAbsenceOccurrences: Number(e.target.value) } : c)} className={FIELD} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('config.escalade.warningsBeforeSanction')}</span>
                    <input type="number" min={1} value={configForm.warningsBeforeSanction}
                      onChange={(e) => setConfigForm((c) => c ? { ...c, warningsBeforeSanction: Number(e.target.value) } : c)} className={FIELD} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('config.escalade.defaultExpectedStart')}</span>
                    <input type="time" value={configForm.defaultExpectedStart}
                      onChange={(e) => setConfigForm((c) => c ? { ...c, defaultExpectedStart: e.target.value } : c)} className={FIELD} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('config.escalade.defaultToleranceMin')}</span>
                    <input type="number" min={0} value={configForm.defaultToleranceMin}
                      onChange={(e) => setConfigForm((c) => c ? { ...c, defaultToleranceMin: Number(e.target.value) } : c)} className={FIELD} />
                  </label>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">{t('config.escalade.defaultWorkdays')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((d) => (
                      <button key={d} type="button" onClick={() => toggleConfigWorkday(d)}
                        className={cn('rounded-full border px-2 py-0.5 text-[11px]',
                          configForm.defaultWorkdays.includes(d) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent')}>
                        {t(`weekdays.${d}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end">
                  <button type="button" disabled={saveConfigMut.isPending} onClick={() => saveConfigMut.mutate()}
                    className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                    {saveConfigMut.isPending ? t('config.saving') : t('config.save')}
                  </button>
                </div>
              </>
            )}
          </section>

          {/* Badgeuses */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t('config.devices.title')}</h2>
              <button type="button" onClick={() => { resetDeviceForm(); setShowDeviceForm(true) }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90">
                <Plus className="h-4 w-4" /> {t('config.devices.new')}
              </button>
            </div>

            {showDeviceForm && (
              <div className="max-w-2xl space-y-3 rounded-xl border border-border bg-card p-4">
                <h3 className="text-sm font-semibold">{t('config.devices.form.title')}</h3>
                {deviceError && <p className="text-sm text-destructive">{deviceError}</p>}
                <input type="text" placeholder={t('config.devices.form.name')} value={deviceForm.name}
                  onChange={(e) => setDeviceForm((f) => ({ ...f, name: e.target.value }))} className={FIELD} />
                <input type="url" placeholder={t('config.devices.form.baseUrl')} value={deviceForm.base_url}
                  onChange={(e) => setDeviceForm((f) => ({ ...f, base_url: e.target.value }))} className={FIELD} />
                <div className="flex gap-2">
                  <select value={deviceForm.auth_type} onChange={(e) => setDeviceForm((f) => ({ ...f, auth_type: e.target.value }))} className={FIELD}>
                    {AUTH_TYPES.map((a) => <option key={a} value={a}>{t(`config.devices.authTypes.${a}`)}</option>)}
                  </select>
                  <input type="text" placeholder={t('config.devices.form.authHeaderName')} value={deviceForm.auth_header_name}
                    onChange={(e) => setDeviceForm((f) => ({ ...f, auth_header_name: e.target.value }))} className={FIELD} />
                </div>
                <input type="password"
                  placeholder={editingDeviceHasSecret ? t('config.devices.form.authSecretPlaceholderSet') : t('config.devices.form.authSecret')}
                  value={deviceForm.auth_secret} onChange={(e) => setDeviceForm((f) => ({ ...f, auth_secret: e.target.value }))} className={FIELD} />
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">{t('config.devices.form.pollInterval')}</span>
                  <input type="number" min={1} value={deviceForm.poll_interval_min}
                    onChange={(e) => setDeviceForm((f) => ({ ...f, poll_interval_min: Number(e.target.value) }))} className={FIELD} />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={deviceForm.is_active} onChange={(e) => setDeviceForm((f) => ({ ...f, is_active: e.target.checked }))} />
                  {t('config.devices.form.active')}
                </label>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('config.devices.form.fieldMapping')}</label>
                  <p className="mb-1 text-xs text-muted-foreground">{t('config.devices.form.fieldMappingHint')}</p>
                  <textarea value={deviceForm.field_mapping} rows={6} spellCheck={false}
                    onChange={(e) => setDeviceForm((f) => ({ ...f, field_mapping: e.target.value }))}
                    className={cn(FIELD, 'font-mono text-xs')} />
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={resetDeviceForm} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent">{t('config.devices.form.cancel')}</button>
                  <button type="button" disabled={!deviceForm.name || !deviceForm.base_url || saveDeviceMut.isPending} onClick={() => saveDeviceMut.mutate()}
                    className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                    {saveDeviceMut.isPending ? t('config.devices.form.submitting') : t('config.devices.form.submit')}
                  </button>
                </div>
              </div>
            )}

            {devicesQ.isLoading && <p className="text-sm text-muted-foreground">{t('config.devices.loading')}</p>}
            {devicesQ.isError && <p className="text-sm text-destructive">{t('config.devices.loadError')}</p>}
            {!devicesQ.isLoading && (devicesQ.data?.length ?? 0) === 0 && (
              <p className="rounded-xl border border-border bg-card py-8 text-center text-sm text-muted-foreground">{t('config.devices.empty')}</p>
            )}
            {(devicesQ.data?.length ?? 0) > 0 && (
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">{t('config.devices.columns.name')}</th>
                    <th className="px-3 py-2">{t('config.devices.columns.baseUrl')}</th>
                    <th className="px-3 py-2">{t('config.devices.columns.authType')}</th>
                    <th className="px-3 py-2">{t('config.devices.columns.pollInterval')}</th>
                    <th className="px-3 py-2">{t('config.devices.columns.secret')}</th>
                    <th className="px-3 py-2">{t('config.devices.columns.lastSync')}</th>
                    <th className="px-3 py-2 text-right">{t('config.devices.columns.actions')}</th>
                  </tr></thead>
                  <tbody>
                    {(devicesQ.data ?? []).map((d) => {
                      const test = deviceTestResult[d.id]
                      return (
                        <tr key={d.id} className="border-b border-border/60 last:border-0 align-top">
                          <td className="px-3 py-2 font-medium">{d.name}</td>
                          <td className="px-3 py-2 max-w-[14rem] truncate text-xs text-muted-foreground" title={d.base_url}>{d.base_url}</td>
                          <td className="px-3 py-2">{t(`config.devices.authTypes.${d.auth_type}`, { defaultValue: d.auth_type })}</td>
                          <td className="px-3 py-2 text-muted-foreground">{d.poll_interval_min}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {d.has_secret ? t('config.devices.secretConfigured') : t('config.devices.secretNotSet')}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {d.last_sync_at ? new Date(d.last_sync_at).toLocaleString() : t('config.devices.neverSynced')}
                            {test && (
                              <p className={cn('mt-1', test.ok ? 'text-emerald-700' : 'text-destructive')}>
                                {test.ok ? t('config.devices.testResultOk', { count: test.count }) : (test.error ?? t('config.devices.testResultFail'))}
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center justify-end gap-1.5">
                              <button type="button" disabled={testDeviceMut.isPending} onClick={() => testDeviceMut.mutate(d.id)}
                                title={t('config.devices.test')} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50">
                                <Zap className="h-3.5 w-3.5" />
                              </button>
                              <button type="button" disabled={syncDeviceMut.isPending} onClick={() => syncDeviceMut.mutate(d.id)}
                                title={t('config.devices.sync')} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50">
                                <RefreshCw className="h-3.5 w-3.5" />
                              </button>
                              <button type="button" onClick={() => startEditDevice(d)} title={t('config.devices.edit')}
                                className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button type="button"
                                onClick={() => { if (window.confirm(t('config.devices.deleteConfirm'))) deleteDeviceMut.mutate(d.id) }}
                                title={t('config.devices.delete')} className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Horaires de référence */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t('config.schedules.title')}</h2>
              <button type="button" onClick={() => { resetScheduleForm(); setShowScheduleForm(true) }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90">
                <Plus className="h-4 w-4" /> {t('config.schedules.new')}
              </button>
            </div>

            {showScheduleForm && (
              <div className="max-w-2xl space-y-3 rounded-xl border border-border bg-card p-4">
                <h3 className="text-sm font-semibold">{t('config.schedules.form.title')}</h3>
                {scheduleError && <p className="text-sm text-destructive">{scheduleError}</p>}
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">{t('config.schedules.form.scope')}</span>
                  <select value={scheduleForm.scope} onChange={(e) => setScheduleForm((f) => ({ ...f, scope: e.target.value }))} className={FIELD}>
                    <option value="tenant">{t('config.schedules.scopes.tenant')}</option>
                    <option value="department">{t('config.schedules.scopes.department')}</option>
                    <option value="employee">{t('config.schedules.scopes.employee')}</option>
                  </select>
                </label>
                {scheduleForm.scope !== 'tenant' && (
                  <label className="block text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('config.schedules.form.scopeId')}</span>
                    <input type="text" placeholder={t('config.schedules.form.scopeIdPlaceholder')} value={scheduleForm.scope_id}
                      onChange={(e) => setScheduleForm((f) => ({ ...f, scope_id: e.target.value }))} className={FIELD} />
                  </label>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('config.schedules.form.expectedStart')}</span>
                    <input type="time" value={scheduleForm.expected_start}
                      onChange={(e) => setScheduleForm((f) => ({ ...f, expected_start: e.target.value }))} className={FIELD} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('config.schedules.form.expectedEnd')}</span>
                    <input type="time" value={scheduleForm.expected_end}
                      onChange={(e) => setScheduleForm((f) => ({ ...f, expected_end: e.target.value }))} className={FIELD} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('config.schedules.form.tolerance')}</span>
                    <input type="number" min={0} value={scheduleForm.tolerance_min}
                      onChange={(e) => setScheduleForm((f) => ({ ...f, tolerance_min: Number(e.target.value) }))} className={FIELD} />
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input type="checkbox" checked={scheduleForm.is_active} onChange={(e) => setScheduleForm((f) => ({ ...f, is_active: e.target.checked }))} />
                    {t('config.schedules.form.active')}
                  </label>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">{t('config.schedules.form.workdays')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((d) => (
                      <button key={d} type="button" onClick={() => toggleScheduleWorkday(d)}
                        className={cn('rounded-full border px-2 py-0.5 text-[11px]',
                          scheduleForm.workdays.includes(d) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent')}>
                        {t(`weekdays.${d}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={resetScheduleForm} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent">{t('config.schedules.form.cancel')}</button>
                  <button type="button"
                    disabled={(scheduleForm.scope !== 'tenant' && !scheduleForm.scope_id) || !scheduleForm.expected_start || saveScheduleMut.isPending}
                    onClick={() => saveScheduleMut.mutate()}
                    className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                    {saveScheduleMut.isPending ? t('config.schedules.form.submitting') : t('config.schedules.form.submit')}
                  </button>
                </div>
              </div>
            )}

            {schedulesQ.isLoading && <p className="text-sm text-muted-foreground">{t('config.schedules.loading')}</p>}
            {schedulesQ.isError && <p className="text-sm text-destructive">{t('config.schedules.loadError')}</p>}
            {!schedulesQ.isLoading && (schedulesQ.data?.length ?? 0) === 0 && (
              <p className="rounded-xl border border-border bg-card py-8 text-center text-sm text-muted-foreground">{t('config.schedules.empty')}</p>
            )}
            {(schedulesQ.data?.length ?? 0) > 0 && (
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">{t('config.schedules.columns.scope')}</th>
                    <th className="px-3 py-2">{t('config.schedules.columns.scopeId')}</th>
                    <th className="px-3 py-2">{t('config.schedules.columns.expectedStart')}</th>
                    <th className="px-3 py-2">{t('config.schedules.columns.expectedEnd')}</th>
                    <th className="px-3 py-2">{t('config.schedules.columns.tolerance')}</th>
                    <th className="px-3 py-2">{t('config.schedules.columns.workdays')}</th>
                    <th className="px-3 py-2 text-right">{t('config.schedules.columns.actions')}</th>
                  </tr></thead>
                  <tbody>
                    {(schedulesQ.data ?? []).map((s) => (
                      <tr key={s.id} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2">{t(`config.schedules.scopes.${s.scope}`, { defaultValue: s.scope })}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{s.scope_id ?? '—'}</td>
                        <td className="px-3 py-2">{s.expected_start.slice(0, 5)}</td>
                        <td className="px-3 py-2">{s.expected_end ? s.expected_end.slice(0, 5) : '—'}</td>
                        <td className="px-3 py-2 text-muted-foreground">{s.tolerance_min}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{s.workdays.map((d) => t(`weekdays.${d}`)).join(', ')}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1.5">
                            <button type="button" onClick={() => startEditSchedule(s)} title={t('config.schedules.edit')}
                              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button type="button"
                              onClick={() => { if (window.confirm(t('config.schedules.deleteConfirm'))) deleteScheduleMut.mutate(s.id) }}
                              title={t('config.schedules.delete')} className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
