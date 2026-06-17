import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ShieldHalf, Plus, Trash2, Send, CheckCircle2, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Tab = 'sso' | 'siem' | 'events'
const SSO_PROVIDERS = ['oidc', 'saml', 'ldap'] as const
const ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly', 'dg', 'raf_site'] as const
const SIEM_TRANSPORTS = ['webhook', 'syslog_http'] as const
const SIEM_FORMATS = ['json', 'cef'] as const
const CATEGORIES = ['auth', 'rbac', 'data_access', 'export', 'config', 'admin'] as const

interface GroupMapping { group: string; role: string }
interface SsoConfig {
  enabled: boolean; provider: string; issuer?: string | null; client_id?: string | null
  domains: string[]; default_role: string; jit_provisioning: boolean; group_mappings: GroupMapping[]; secretSet: boolean
}
interface SiemConfig {
  enabled: boolean; transport: string; endpoint?: string | null; format: string; categories: string[]; secretSet: boolean
}
interface SecurityEventRow { id: string; action: string; category: string; userId: string | null; ip: string | null; at: string; forwarded: boolean }

const CAT_STYLE: Record<string, string> = {
  auth: 'bg-sky-100 text-sky-800', rbac: 'bg-amber-100 text-amber-800',
  data_access: 'bg-violet-100 text-violet-800', export: 'bg-indigo-100 text-indigo-800',
  config: 'bg-slate-200 text-slate-700', admin: 'bg-rose-100 text-rose-800',
}

export default function SecurityPage() {
  const { t } = useTranslation('security')
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('sso')
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null)
  useEffect(() => {
    if (!flash) return undefined
    const id = setTimeout(() => setFlash(null), 4000)
    return () => clearTimeout(id)
  }, [flash])

  // ── SSO ──
  const ssoQ = useQuery({ queryKey: ['security', 'sso'], queryFn: async () => (await api.get('/security/sso-config')).data.data as SsoConfig })
  const [sso, setSso] = useState<SsoConfig | null>(null)
  const [ssoSecret, setSsoSecret] = useState('')
  useEffect(() => { if (ssoQ.data) setSso(ssoQ.data) }, [ssoQ.data])
  const saveSso = useMutation({
    mutationFn: async () => {
      if (!sso) return
      await api.put('/security/sso-config', {
        enabled: sso.enabled, provider: sso.provider, issuer: sso.issuer || undefined, clientId: sso.client_id || undefined,
        clientSecret: ssoSecret || undefined, domains: sso.domains, defaultRole: sso.default_role,
        jitProvisioning: sso.jit_provisioning, groupMappings: sso.group_mappings.filter((m) => m.group.trim()),
      })
    },
    onSuccess: () => { setSsoSecret(''); qc.invalidateQueries({ queryKey: ['security', 'sso'] }); setFlash({ ok: true, msg: t('saved') }) },
    onError: () => setFlash({ ok: false, msg: t('saveError') }),
  })
  const testSso = useMutation({
    mutationFn: async () => (await api.post('/security/sso-config/test', { issuer: sso?.issuer })).data.data as { ok: boolean; issuer?: string },
    onSuccess: (d) => setFlash(d.ok ? { ok: true, msg: t('sso.testOk', { issuer: d.issuer }) } : { ok: false, msg: t('sso.testFail') }),
    onError: () => setFlash({ ok: false, msg: t('sso.testFail') }),
  })

  // ── SIEM ──
  const siemQ = useQuery({ queryKey: ['security', 'siem'], queryFn: async () => (await api.get('/security/siem-config')).data.data as SiemConfig })
  const [siem, setSiem] = useState<SiemConfig | null>(null)
  const [siemSecret, setSiemSecret] = useState('')
  useEffect(() => { if (siemQ.data) setSiem(siemQ.data) }, [siemQ.data])
  const saveSiem = useMutation({
    mutationFn: async () => {
      if (!siem) return
      await api.put('/security/siem-config', {
        enabled: siem.enabled, transport: siem.transport, endpoint: siem.endpoint || undefined,
        format: siem.format, secret: siemSecret || undefined, categories: siem.categories,
      })
    },
    onSuccess: () => { setSiemSecret(''); qc.invalidateQueries({ queryKey: ['security', 'siem'] }); setFlash({ ok: true, msg: t('saved') }) },
    onError: () => setFlash({ ok: false, msg: t('saveError') }),
  })
  const testSiem = useMutation({
    mutationFn: async () => (await api.post('/security/siem-config/test')).data.data as { ok: boolean; status: number | null },
    onSuccess: (d) => setFlash(d.ok ? { ok: true, msg: t('siem.testOk', { status: d.status }) } : { ok: false, msg: t('siem.testFail') }),
    onError: () => setFlash({ ok: false, msg: t('siem.testFail') }),
  })

  // ── Events ──
  const eventsQ = useQuery({ queryKey: ['security', 'events'], enabled: tab === 'events', queryFn: async () => (await api.get('/security/events')).data.data as SecurityEventRow[] })

  const toggleCategory = (c: string) => setSiem((s) => s ? { ...s, categories: s.categories.includes(c) ? s.categories.filter((x) => x !== c) : [...s.categories, c] } : s)
  const TabBtn = ({ value, label }: { value: Tab; label: string }) => (
    <button type="button" onClick={() => setTab(value)}
      className={cn('rounded-lg px-3 py-1.5 text-sm font-medium', tab === value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent')}>{label}</button>
  )
  const field = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm'

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><ShieldHalf className="h-5 w-5" /></div>
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

      <div className="flex w-fit gap-1.5 rounded-xl border border-border bg-muted/40 p-1">
        <TabBtn value="sso" label={t('tabs.sso')} />
        <TabBtn value="siem" label={t('tabs.siem')} />
        <TabBtn value="events" label={t('tabs.events')} />
      </div>

      {/* ── SSO / AD ── */}
      {tab === 'sso' && sso && (
        <div className="max-w-2xl space-y-3 rounded-xl border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">{t('sso.intro')}</p>
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={sso.enabled} onChange={(e) => setSso({ ...sso, enabled: e.target.checked })} /> {t('sso.enabled')}</label>
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('sso.provider')}</label>
            <select value={sso.provider} onChange={(e) => setSso({ ...sso, provider: e.target.value })} className={field}>
              {SSO_PROVIDERS.map((p) => <option key={p} value={p}>{t(`sso.providers.${p}`)}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <input type="url" placeholder={t('sso.issuer')} value={sso.issuer ?? ''} onChange={(e) => setSso({ ...sso, issuer: e.target.value })} className={field} />
            <button type="button" disabled={!sso.issuer || testSso.isPending} onClick={() => testSso.mutate()} className="shrink-0 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-50">{testSso.isPending ? t('sso.testing') : t('sso.test')}</button>
          </div>
          <input type="text" placeholder={t('sso.clientId')} value={sso.client_id ?? ''} onChange={(e) => setSso({ ...sso, client_id: e.target.value })} className={field} />
          <input type="password" placeholder={sso.secretSet ? t('sso.secretSet') : t('sso.clientSecret')} value={ssoSecret} onChange={(e) => setSsoSecret(e.target.value)} className={field} />
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('sso.domains')}</label>
            <input type="text" placeholder={t('sso.domainsHint')} value={sso.domains.join(', ')} onChange={(e) => setSso({ ...sso, domains: e.target.value.split(',').map((d) => d.trim()).filter(Boolean) })} className={field} />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground">{t('sso.defaultRole')}</label>
              <select value={sso.default_role} onChange={(e) => setSso({ ...sso, default_role: e.target.value })} className={field}>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={sso.jit_provisioning} onChange={(e) => setSso({ ...sso, jit_provisioning: e.target.checked })} /> {t('sso.jit')}</label>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('sso.groupMappings')}</label>
            {sso.group_mappings.map((m, i) => (
              <div key={i} className="flex gap-2">
                <input type="text" placeholder={t('sso.group')} value={m.group} onChange={(e) => setSso({ ...sso, group_mappings: sso.group_mappings.map((x, j) => j === i ? { ...x, group: e.target.value } : x) })} className={field} />
                <select value={m.role} onChange={(e) => setSso({ ...sso, group_mappings: sso.group_mappings.map((x, j) => j === i ? { ...x, role: e.target.value } : x) })} className={field}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <button type="button" onClick={() => setSso({ ...sso, group_mappings: sso.group_mappings.filter((_, j) => j !== i) })} className="rounded-md p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
            <button type="button" onClick={() => setSso({ ...sso, group_mappings: [...sso.group_mappings, { group: '', role: 'employee' }] })} className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"><Plus className="h-3.5 w-3.5" /> {t('sso.addMapping')}</button>
          </div>

          <div className="flex justify-end">
            <button type="button" disabled={saveSso.isPending} onClick={() => saveSso.mutate()} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">{saveSso.isPending ? t('saving') : t('save')}</button>
          </div>
        </div>
      )}

      {/* ── SIEM ── */}
      {tab === 'siem' && siem && (
        <div className="max-w-2xl space-y-3 rounded-xl border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">{t('siem.intro')}</p>
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={siem.enabled} onChange={(e) => setSiem({ ...siem, enabled: e.target.checked })} /> {t('siem.enabled')}</label>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground">{t('siem.transport')}</label>
              <select value={siem.transport} onChange={(e) => setSiem({ ...siem, transport: e.target.value })} className={field}>
                {SIEM_TRANSPORTS.map((tr) => <option key={tr} value={tr}>{t(`siem.transports.${tr}`)}</option>)}
              </select>
            </div>
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground">{t('siem.format')}</label>
              <select value={siem.format} onChange={(e) => setSiem({ ...siem, format: e.target.value })} className={field}>
                {SIEM_FORMATS.map((f) => <option key={f} value={f}>{t(`siem.formats.${f}`)}</option>)}
              </select>
            </div>
          </div>
          <input type="url" placeholder={t('siem.endpoint')} value={siem.endpoint ?? ''} onChange={(e) => setSiem({ ...siem, endpoint: e.target.value })} className={field} />
          <input type="password" placeholder={siem.secretSet ? t('siem.secretSet') : t('siem.secret')} value={siemSecret} onChange={(e) => setSiemSecret(e.target.value)} className={field} />
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('siem.categories')}</label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => (
                <button key={c} type="button" onClick={() => toggleCategory(c)}
                  className={cn('rounded-full border px-2 py-0.5 text-[11px]', siem.categories.includes(c) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent')}>
                  {t(`siem.categoryNames.${c}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" disabled={!siem.endpoint || testSiem.isPending} onClick={() => testSiem.mutate()} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"><Send className="h-3.5 w-3.5" /> {testSiem.isPending ? t('siem.testing') : t('siem.test')}</button>
            <button type="button" disabled={saveSiem.isPending} onClick={() => saveSiem.mutate()} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">{saveSiem.isPending ? t('saving') : t('save')}</button>
          </div>
        </div>
      )}

      {/* ── Events ── */}
      {tab === 'events' && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('events.intro')}</p>
          {(eventsQ.data?.length ?? 0) === 0 && <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('events.empty')}</p>}
          {(eventsQ.data?.length ?? 0) > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2">{t('events.when')}</th>
                  <th className="px-3 py-2">{t('events.action')}</th>
                  <th className="px-3 py-2">{t('events.category')}</th>
                  <th className="px-3 py-2">{t('events.ip')}</th>
                  <th className="px-3 py-2">{t('events.forwarded')}</th>
                </tr></thead>
                <tbody>
                  {(eventsQ.data ?? []).map((e) => (
                    <tr key={e.id} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(e.at).toLocaleString()}</td>
                      <td className="px-3 py-2 font-mono text-xs">{e.action}</td>
                      <td className="px-3 py-2"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', CAT_STYLE[e.category] ?? 'bg-muted')}>{t(`siem.categoryNames.${e.category}`, { defaultValue: e.category })}</span></td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{e.ip ?? '—'}</td>
                      <td className="px-3 py-2">{e.forwarded ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <span className="text-muted-foreground">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
