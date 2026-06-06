import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Webhook, KeyRound, Cable, Plus, Trash2, Send, Loader2, Copy, CheckCircle, XCircle, ShieldCheck,
} from 'lucide-react'
import { api } from '@/lib/api'

interface EventDef { key: string; label: string }
interface Hook { id: string; name: string; target_url: string; events: string[]; is_active: boolean; last_status: number | null; last_delivery_at: string | null }
interface ApiKey { id: string; name: string; key_prefix: string; scopes: string[]; is_active: boolean; last_used_at: string | null; expires_at: string | null }
interface Connector { id: string; name: string; base_url: string; auth_type: string; is_active: boolean; last_test_status: number | null; has_secret: boolean }
interface Delivery { id: string; event: string; status: number | null; ok: boolean; response_excerpt: string | null; created_at: string }

const SUB = [
  { id: 'webhooks',   labelKey: 'connectivity.sub.webhooks',   icon: Webhook },
  { id: 'api-keys',   labelKey: 'connectivity.sub.apiKeys',    icon: KeyRound },
  { id: 'connectors', labelKey: 'connectivity.sub.connectors', icon: Cable },
] as const
type Sub = typeof SUB[number]['id']

export default function ConnectivityTab() {
  const { t } = useTranslation('settings')
  const [sub, setSub] = useState<Sub>('webhooks')
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800 flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span><Trans i18nKey="connectivity.intro" ns="settings" components={[<strong />, <strong />, <strong />]} /></span>
      </div>
      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        {SUB.map(({ id, labelKey, icon: Icon }) => (
          <button key={id} onClick={() => setSub(id)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${sub === id ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            <Icon className="h-4 w-4" /> {t(labelKey)}
          </button>
        ))}
      </div>
      {sub === 'webhooks'   && <WebhooksSection />}
      {sub === 'api-keys'   && <ApiKeysSection />}
      {sub === 'connectors' && <ConnectorsSection />}
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', placeholder }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
    </div>
  )
}

function SecretBox({ value, onClose }: { value: string; onClose: () => void }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
      <p className="mb-2 font-medium text-amber-800">{t('connectivity.secretBox.warning')}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all rounded bg-white px-2 py-1 text-xs">{value}</code>
        <button onClick={() => { navigator.clipboard.writeText(value); setCopied(true) }}
          className="inline-flex items-center gap-1 rounded-lg bg-amber-600 px-2 py-1 text-xs text-white">
          <Copy className="h-3 w-3" /> {copied ? t('connectivity.secretBox.copied') : t('connectivity.secretBox.copy')}
        </button>
        <button onClick={onClose} className="text-amber-700 hover:underline text-xs">{t('connectivity.secretBox.close')}</button>
      </div>
    </div>
  )
}

// ── Webhooks ──────────────────────────────────────────────────────────────────
function WebhooksSection() {
  const { t } = useTranslation('settings')
  const qc = useQueryClient()
  const [show, setShow] = useState(false)
  const [form, setForm] = useState({ name: '', target_url: '', events: [] as string[] })
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, string>>({})

  const { data: events } = useQuery<{ data: EventDef[] }>({ queryKey: ['int-events'], queryFn: () => api.get('/integrations/events').then(r => r.data) })
  const { data, isLoading } = useQuery<{ data: Hook[] }>({ queryKey: ['int-webhooks'], queryFn: () => api.get('/integrations/webhooks').then(r => r.data) })

  const create = useMutation({
    mutationFn: () => api.post('/integrations/webhooks', form).then(r => r.data),
    onSuccess: (res: { secret: string }) => { setSecret(res.secret); setError(null); setForm({ name: '', target_url: '', events: [] }); setShow(false); qc.invalidateQueries({ queryKey: ['int-webhooks'] }) },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? t('connectivity.defaultError')),
  })
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/integrations/webhooks/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['int-webhooks'] }) })
  const toggle = useMutation({ mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) => api.patch(`/integrations/webhooks/${id}`, { is_active }), onSuccess: () => qc.invalidateQueries({ queryKey: ['int-webhooks'] }) })
  const test = useMutation({
    mutationFn: (id: string) => api.post(`/integrations/webhooks/${id}/test`, {}).then(r => ({ id, ...r.data.data })),
    onSuccess: (r: { id: string; ok: boolean; status: number | null }) => setTestResult(p => ({ ...p, [r.id]: r.ok ? t('connectivity.webhooks.testOk', { status: r.status }) : t('connectivity.webhooks.testFailed', { status: r.status ?? t('connectivity.webhooks.testNetwork') }) })),
  })

  const toggleEvent = (k: string) => setForm(p => ({ ...p, events: p.events.includes(k) ? p.events.filter(x => x !== k) : [...p.events, k] }))
  const hooks = data?.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">{t('connectivity.webhooks.count', { count: hooks.length })}</p>
        <button onClick={() => { setShow(v => !v); setSecret(null) }} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"><Plus className="h-4 w-4" /> {t('connectivity.webhooks.add')}</button>
      </div>
      {secret && <SecretBox value={secret} onClose={() => setSecret(null)} />}
      {show && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <Field label={t('connectivity.webhooks.name')} value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder={t('connectivity.webhooks.namePlaceholder')} />
          <Field label={t('connectivity.webhooks.targetUrl')} value={form.target_url} onChange={v => setForm(p => ({ ...p, target_url: v }))} placeholder={t('connectivity.webhooks.targetUrlPlaceholder')} />
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('connectivity.webhooks.events')}</label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {(events?.data ?? []).map(ev => (
                <button key={ev.key} type="button" onClick={() => toggleEvent(ev.key)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${form.events.includes(ev.key) ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'}`}>{ev.label}</button>
              ))}
            </div>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button onClick={() => create.mutate()} disabled={create.isPending || !form.name || !form.target_url || form.events.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {t('connectivity.webhooks.create')}
          </button>
        </div>
      )}
      {isLoading ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : (
        <div className="space-y-2">
          {hooks.map(h => (
            <div key={h.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{h.name} {h.is_active ? <span className="text-xs text-emerald-600">{t('connectivity.webhooks.active')}</span> : <span className="text-xs text-muted-foreground">{t('connectivity.webhooks.inactive')}</span>}</p>
                  <p className="truncate text-xs text-muted-foreground">{h.target_url}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{h.events.join(', ')}</p>
                  {testResult[h.id] && <p className="mt-1 text-xs font-medium">{testResult[h.id]}</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => test.mutate(h.id)} disabled={test.isPending} title={t('connectivity.webhooks.testTitle')} className="rounded-lg border border-border p-1.5 hover:bg-accent"><Send className="h-4 w-4" /></button>
                  <button onClick={() => toggle.mutate({ id: h.id, is_active: !h.is_active })} title={t('connectivity.webhooks.toggleTitle')} className="rounded-lg border border-border p-1.5 hover:bg-accent">{h.is_active ? <XCircle className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}</button>
                  <button onClick={() => del.mutate(h.id)} title={t('connectivity.webhooks.deleteTitle')} className="rounded-lg border border-border p-1.5 text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
            </div>
          ))}
          {hooks.length === 0 && <p className="text-sm text-muted-foreground">{t('connectivity.webhooks.empty')}</p>}
        </div>
      )}
    </div>
  )
}

// ── Clés API ──────────────────────────────────────────────────────────────────
function ApiKeysSection() {
  const { t } = useTranslation('settings')
  const qc = useQueryClient()
  const [show, setShow] = useState(false)
  const [form, setForm] = useState({ name: '', scopes: [] as string[] })
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: scopes } = useQuery<{ data: string[] }>({ queryKey: ['int-scopes'], queryFn: () => api.get('/integrations/scopes').then(r => r.data) })
  const { data, isLoading } = useQuery<{ data: ApiKey[] }>({ queryKey: ['int-apikeys'], queryFn: () => api.get('/integrations/api-keys').then(r => r.data) })

  const create = useMutation({
    mutationFn: () => api.post('/integrations/api-keys', form).then(r => r.data),
    onSuccess: (res: { apiKey: string }) => { setApiKey(res.apiKey); setError(null); setForm({ name: '', scopes: [] }); setShow(false); qc.invalidateQueries({ queryKey: ['int-apikeys'] }) },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? t('connectivity.defaultError')),
  })
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/integrations/api-keys/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['int-apikeys'] }) })
  const toggle = useMutation({ mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) => api.patch(`/integrations/api-keys/${id}`, { is_active }), onSuccess: () => qc.invalidateQueries({ queryKey: ['int-apikeys'] }) })

  const toggleScope = (sc: string) => setForm(p => ({ ...p, scopes: p.scopes.includes(sc) ? p.scopes.filter(x => x !== sc) : [...p.scopes, sc] }))
  const keys = data?.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">
          <Trans i18nKey="connectivity.apiKeys.count" ns="settings" count={keys.length}
            components={[<code className="text-xs" />, <code className="text-xs" />]} />
        </p>
        <button onClick={() => { setShow(v => !v); setApiKey(null) }} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"><Plus className="h-4 w-4" /> {t('connectivity.apiKeys.add')}</button>
      </div>
      {apiKey && <SecretBox value={apiKey} onClose={() => setApiKey(null)} />}
      {show && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <Field label={t('connectivity.apiKeys.name')} value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder={t('connectivity.apiKeys.namePlaceholder')} />
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('connectivity.apiKeys.scopes')}</label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {(scopes?.data ?? []).map(sc => (
                <button key={sc} type="button" onClick={() => toggleScope(sc)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-mono ${form.scopes.includes(sc) ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'}`}>{sc}</button>
              ))}
            </div>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button onClick={() => create.mutate()} disabled={create.isPending || !form.name || form.scopes.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {t('connectivity.apiKeys.generate')}
          </button>
        </div>
      )}
      {isLoading ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="p-3">{t('connectivity.apiKeys.table.name')}</th><th className="p-3">{t('connectivity.apiKeys.table.prefix')}</th><th className="p-3">{t('connectivity.apiKeys.table.scopes')}</th><th className="p-3">{t('connectivity.apiKeys.table.lastUsed')}</th><th className="p-3">{t('connectivity.apiKeys.table.status')}</th><th className="p-3"></th></tr></thead>
            <tbody className="divide-y divide-border">
              {keys.map(k => (
                <tr key={k.id}>
                  <td className="p-3 font-medium">{k.name}</td>
                  <td className="p-3 font-mono text-xs">{k.key_prefix}</td>
                  <td className="p-3 text-xs">{k.scopes.join(', ')}</td>
                  <td className="p-3 text-xs text-muted-foreground">{k.last_used_at ? new Date(k.last_used_at).toLocaleString('fr-FR') : '—'}</td>
                  <td className="p-3 text-xs">{k.is_active ? <span className="text-emerald-600">{t('connectivity.apiKeys.active')}</span> : <span className="text-muted-foreground">{t('connectivity.apiKeys.revoked')}</span>}</td>
                  <td className="p-3 text-right">
                    <button onClick={() => toggle.mutate({ id: k.id, is_active: !k.is_active })} className="mr-1 rounded-lg border border-border p-1.5 hover:bg-accent" title={t('connectivity.apiKeys.toggleTitle')}>{k.is_active ? <XCircle className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}</button>
                    <button onClick={() => del.mutate(k.id)} className="rounded-lg border border-border p-1.5 text-red-600 hover:bg-red-50" title={t('connectivity.apiKeys.deleteTitle')}><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
              {keys.length === 0 && <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">{t('connectivity.apiKeys.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Connecteurs ───────────────────────────────────────────────────────────────
function ConnectorsSection() {
  const { t } = useTranslation('settings')
  const qc = useQueryClient()
  const [show, setShow] = useState(false)
  const [form, setForm] = useState({ name: '', base_url: '', auth_type: 'none', auth_secret: '', auth_header_name: '' })
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, string>>({})

  const { data, isLoading } = useQuery<{ data: Connector[] }>({ queryKey: ['int-connectors'], queryFn: () => api.get('/integrations/connectors').then(r => r.data) })
  const create = useMutation({
    mutationFn: () => api.post('/integrations/connectors', { ...form, auth_secret: form.auth_secret || undefined, auth_header_name: form.auth_header_name || undefined }).then(r => r.data),
    onSuccess: () => { setError(null); setForm({ name: '', base_url: '', auth_type: 'none', auth_secret: '', auth_header_name: '' }); setShow(false); qc.invalidateQueries({ queryKey: ['int-connectors'] }) },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? t('connectivity.defaultError')),
  })
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/integrations/connectors/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['int-connectors'] }) })
  const test = useMutation({
    mutationFn: (id: string) => api.post(`/integrations/connectors/${id}/test`, {}).then(r => ({ id, ...r.data.data })),
    onSuccess: (r: { id: string; ok: boolean; message: string }) => setTestResult(p => ({ ...p, [r.id]: (r.ok ? '✓ ' : '✗ ') + r.message })),
  })
  const connectors = data?.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">{t('connectivity.connectors.count', { count: connectors.length })}</p>
        <button onClick={() => setShow(v => !v)} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"><Plus className="h-4 w-4" /> {t('connectivity.connectors.add')}</button>
      </div>
      {show && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <Field label={t('connectivity.connectors.name')} value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder={t('connectivity.connectors.namePlaceholder')} />
          <Field label={t('connectivity.connectors.baseUrl')} value={form.base_url} onChange={v => setForm(p => ({ ...p, base_url: v }))} placeholder={t('connectivity.connectors.baseUrlPlaceholder')} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('connectivity.connectors.auth')}</label>
              <select value={form.auth_type} onChange={e => setForm(p => ({ ...p, auth_type: e.target.value }))} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
                <option value="none">{t('connectivity.connectors.authNone')}</option><option value="bearer">{t('connectivity.connectors.authBearer')}</option><option value="basic">{t('connectivity.connectors.authBasic')}</option><option value="api_key">{t('connectivity.connectors.authApiKey')}</option>
              </select>
            </div>
            {form.auth_type === 'api_key' && <Field label={t('connectivity.connectors.headerName')} value={form.auth_header_name} onChange={v => setForm(p => ({ ...p, auth_header_name: v }))} placeholder={t('connectivity.connectors.headerNamePlaceholder')} />}
          </div>
          {form.auth_type !== 'none' && <Field label={t('connectivity.connectors.secret')} type="password" value={form.auth_secret} onChange={v => setForm(p => ({ ...p, auth_secret: v }))} placeholder={form.auth_type === 'basic' ? t('connectivity.connectors.secretPlaceholderBasic') : t('connectivity.connectors.secretPlaceholderToken')} />}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button onClick={() => create.mutate()} disabled={create.isPending || !form.name || !form.base_url}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {t('connectivity.connectors.create')}
          </button>
        </div>
      )}
      {isLoading ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : (
        <div className="space-y-2">
          {connectors.map(c => (
            <div key={c.id} className="rounded-xl border border-border bg-card p-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{c.name} {c.is_active ? <span className="text-xs text-emerald-600">{t('connectivity.connectors.active')}</span> : <span className="text-xs text-muted-foreground">{t('connectivity.connectors.inactive')}</span>}</p>
                <p className="truncate text-xs text-muted-foreground">{c.base_url} · {t('connectivity.connectors.authLabel', { type: c.auth_type })}</p>
                {testResult[c.id] && <p className="mt-1 text-xs font-medium">{testResult[c.id]}</p>}
              </div>
              <div className="flex shrink-0 gap-1">
                <button onClick={() => test.mutate(c.id)} disabled={test.isPending} title={t('connectivity.connectors.testTitle')} className="rounded-lg border border-border p-1.5 hover:bg-accent"><Send className="h-4 w-4" /></button>
                <button onClick={() => del.mutate(c.id)} title={t('connectivity.connectors.deleteTitle')} className="rounded-lg border border-border p-1.5 text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
          ))}
          {connectors.length === 0 && <p className="text-sm text-muted-foreground">{t('connectivity.connectors.empty')}</p>}
        </div>
      )}
    </div>
  )
}
