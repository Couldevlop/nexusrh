import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { FileSignature, Plus, Trash2, Send, X, Check, PenLine } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'

type Tab = 'requests' | 'mine'
const MANAGE_ROLES = ['admin', 'hr_manager']
const WRITE_ROLES = ['admin', 'hr_manager', 'hr_officer']
const DOC_TYPES = ['contract', 'amendment', 'certificate', 'disciplinary', 'offer', 'policy', 'other'] as const

interface RequestRow {
  id: string; title: string; document_type: string; status: string
  signatory_count: number; signed_count: number; expires_at: string | null; created_at: string
}
interface SignatoryRow {
  id: string; name: string; email: string | null; status: string; order_index: number
  signed_at: string | null; ip_address: string | null
}
interface RequestDetail extends RequestRow { signatories: SignatoryRow[] }
interface MineRow { id: string; title: string; document_type: string; status: string; my_status: string; signatory_id: string }

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground', pending: 'bg-amber-100 text-amber-800',
  signed: 'bg-emerald-100 text-emerald-800', declined: 'bg-rose-100 text-rose-800',
  cancelled: 'bg-slate-200 text-slate-600', expired: 'bg-slate-200 text-slate-600',
}

interface DraftSignatory { name: string; email: string }

export default function SignaturePage() {
  const { t } = useTranslation('signature')
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role ?? '')
  const canWrite = WRITE_ROLES.includes(role)
  const canManage = MANAGE_ROLES.includes(role)
  const [tab, setTab] = useState<Tab>('requests')

  const listQ = useQuery({ queryKey: ['signature', 'requests'], queryFn: async () => (await api.get('/signature/requests')).data.data as RequestRow[] })
  const mineQ = useQuery({ queryKey: ['signature', 'mine'], queryFn: async () => (await api.get('/signature/my-requests')).data.data as MineRow[] })

  const [open, setOpen] = useState<string | null>(null)
  const detailQ = useQuery({
    queryKey: ['signature', 'request', open], enabled: !!open,
    queryFn: async () => (await api.get(`/signature/requests/${open}`)).data.data as RequestDetail,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['signature', 'requests'] })
    qc.invalidateQueries({ queryKey: ['signature', 'mine'] })
    if (open) qc.invalidateQueries({ queryKey: ['signature', 'request', open] })
  }

  // ── Création ──
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ title: '', documentType: 'contract', message: '', sequential: false, expiresAt: '' })
  const [signs, setSigns] = useState<DraftSignatory[]>([{ name: '', email: '' }])
  const createReq = useMutation({
    mutationFn: async () => {
      await api.post('/signature/requests', {
        title: form.title, documentType: form.documentType, message: form.message || undefined,
        sequential: form.sequential, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined,
        signatories: signs.filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim(), email: s.email.trim() || undefined })),
      })
    },
    onSuccess: () => { setShowForm(false); setForm({ title: '', documentType: 'contract', message: '', sequential: false, expiresAt: '' }); setSigns([{ name: '', email: '' }]); refresh() },
  })
  const validSigns = signs.filter((s) => s.name.trim()).length

  const sendReq = useMutation({ mutationFn: async (id: string) => { await api.post(`/signature/requests/${id}/send`) }, onSuccess: refresh })
  const cancelReq = useMutation({ mutationFn: async (id: string) => { await api.post(`/signature/requests/${id}/cancel`) }, onSuccess: refresh })
  const deleteReq = useMutation({ mutationFn: async (id: string) => { await api.delete(`/signature/requests/${id}`) }, onSuccess: () => { setOpen(null); refresh() } })

  // ── Signature self-service ──
  const [signing, setSigning] = useState<string | null>(null)
  const [signText, setSignText] = useState('')
  const [declining, setDeclining] = useState<string | null>(null)
  const [declineReason, setDeclineReason] = useState('')
  const doSign = useMutation({
    mutationFn: async (id: string) => { await api.post(`/signature/requests/${id}/sign`, { signatureText: signText }) },
    onSuccess: () => { setSigning(null); setSignText(''); refresh() },
  })
  const doDecline = useMutation({
    mutationFn: async (id: string) => { await api.post(`/signature/requests/${id}/decline`, { reason: declineReason || undefined }) },
    onSuccess: () => { setDeclining(null); setDeclineReason(''); refresh() },
  })

  const docTypeLabel = (key: string) => t(`documentTypes.${key}`, { defaultValue: key })
  const TabBtn = ({ value, label }: { value: Tab; label: string }) => (
    <button type="button" onClick={() => setTab(value)}
      className={cn('rounded-lg px-3 py-1.5 text-sm font-medium', tab === value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent')}>{label}</button>
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><FileSignature className="h-5 w-5" /></div>
          <div>
            <h1 className="text-xl font-bold">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
        {tab === 'requests' && canWrite && (
          <button type="button" onClick={() => setShowForm((s) => !s)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90">
            <Plus className="h-4 w-4" /> {t('requests.new')}
          </button>
        )}
      </div>

      <div className="flex w-fit gap-1.5 rounded-xl border border-border bg-muted/40 p-1">
        <TabBtn value="requests" label={t('tabs.requests')} />
        <TabBtn value="mine" label={t('tabs.mine')} />
      </div>

      {/* ── Demandes (gestion) ── */}
      {tab === 'requests' && (
        <div className="space-y-4">
          {showForm && canWrite && (
            <div className="max-w-2xl space-y-2 rounded-xl border border-border bg-card p-4">
              <input type="text" placeholder={t('requests.title')} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
              <div className="flex gap-2">
                <select value={form.documentType} onChange={(e) => setForm((f) => ({ ...f, documentType: e.target.value }))}
                  className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                  {DOC_TYPES.map((d) => <option key={d} value={d}>{docTypeLabel(d)}</option>)}
                </select>
                <input type="datetime-local" value={form.expiresAt} onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
                  className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
              </div>
              <input type="text" placeholder={t('requests.message')} value={form.message} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" checked={form.sequential} onChange={(e) => setForm((f) => ({ ...f, sequential: e.target.checked }))} />
                {t('requests.sequential')}
              </label>

              <div className="space-y-1.5 pt-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('requests.signatories')}</p>
                {signs.map((s, i) => (
                  <div key={i} className="flex gap-2">
                    <input type="text" placeholder={t('requests.signatoryName')} value={s.name}
                      onChange={(e) => setSigns((arr) => arr.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                      className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
                    <input type="email" placeholder={t('requests.signatoryEmail')} value={s.email}
                      onChange={(e) => setSigns((arr) => arr.map((x, j) => j === i ? { ...x, email: e.target.value } : x))}
                      className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
                    {signs.length > 1 && (
                      <button type="button" onClick={() => setSigns((arr) => arr.filter((_, j) => j !== i))} className="rounded-md p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                    )}
                  </div>
                ))}
                <button type="button" onClick={() => setSigns((arr) => [...arr, { name: '', email: '' }])}
                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent">
                  <Plus className="h-3.5 w-3.5" /> {t('requests.addSignatory')}
                </button>
              </div>

              <div className="flex justify-end pt-1">
                <button type="button" disabled={!form.title.trim() || validSigns === 0 || createReq.isPending} onClick={() => createReq.mutate()}
                  className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                  {createReq.isPending ? t('requests.creating') : t('requests.create')}
                </button>
              </div>
            </div>
          )}

          {(listQ.data?.length ?? 0) === 0 && <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('requests.empty')}</p>}

          <div className="space-y-3">
            {(listQ.data ?? []).map((r) => (
              <div key={r.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button type="button" className="text-left" onClick={() => setOpen((o) => o === r.id ? null : r.id)}>
                    <p className="font-semibold">{r.title}</p>
                    <p className="text-xs text-muted-foreground">{docTypeLabel(r.document_type)} · {t('requests.progress', { signed: r.signed_count, total: r.signatory_count })}</p>
                  </button>
                  <div className="flex items-center gap-2">
                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_STYLE[r.status] ?? 'bg-muted')}>{t(`statuses.${r.status}`)}</span>
                    {r.status === 'draft' && canWrite && <button type="button" onClick={() => sendReq.mutate(r.id)} className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"><Send className="h-3.5 w-3.5" /> {t('requests.send')}</button>}
                    {(r.status === 'draft' || r.status === 'pending') && canManage && <button type="button" onClick={() => { if (window.confirm(t('requests.cancelConfirm'))) cancelReq.mutate(r.id) }} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">{t('requests.cancel')}</button>}
                    {r.status === 'draft' && canManage && <button type="button" onClick={() => { if (window.confirm(t('requests.deleteConfirm'))) deleteReq.mutate(r.id) }} className="rounded-md p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>}
                  </div>
                </div>

                {open === r.id && detailQ.data && (
                  <div className="mt-3 space-y-2 border-t border-border pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('detail.signatories')}</p>
                    {detailQ.data.signatories.map((s) => (
                      <div key={s.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="flex items-center gap-2">
                          <span className="text-[11px] text-muted-foreground">#{s.order_index + 1}</span>
                          <span className="font-medium">{s.name}</span>
                          {s.email && <span className="text-xs text-muted-foreground">{s.email}</span>}
                        </span>
                        <span className="flex items-center gap-2">
                          {s.status === 'signed' && s.signed_at && <span className="text-[11px] text-muted-foreground">{t('detail.signed', { date: new Date(s.signed_at).toLocaleDateString() })}</span>}
                          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', STATUS_STYLE[s.status] ?? 'bg-muted')}>{t(`statuses.${s.status === 'pending' ? 'pending' : s.status}`)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── À signer (self-service) ── */}
      {tab === 'mine' && (
        <div className="space-y-3">
          {(mineQ.data?.length ?? 0) === 0 && <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('mine.empty')}</p>}
          {(mineQ.data ?? []).map((r) => (
            <div key={r.signatory_id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">{r.title}</p>
                  <p className="text-xs text-muted-foreground">{docTypeLabel(r.document_type)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_STYLE[r.my_status] ?? 'bg-muted')}>{t(`statuses.${r.my_status}`)}</span>
                  {r.status === 'pending' && r.my_status === 'pending' && (
                    <>
                      <button type="button" onClick={() => { setSigning(r.id); setSignText('') }} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:opacity-90"><PenLine className="h-3.5 w-3.5" /> {t('mine.sign')}</button>
                      <button type="button" onClick={() => { setDeclining(r.id); setDeclineReason('') }} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">{t('mine.decline')}</button>
                    </>
                  )}
                </div>
              </div>

              {signing === r.id && (
                <div className="mt-3 space-y-2 border-t border-border pt-3">
                  <p className="text-xs font-semibold">{t('mine.signTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('mine.signHint')}</p>
                  <input type="text" placeholder={t('mine.signaturePlaceholder')} value={signText} onChange={(e) => setSignText(e.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-serif text-sm italic" />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setSigning(null)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"><X className="h-3.5 w-3.5" /></button>
                    <button type="button" disabled={!signText.trim() || doSign.isPending} onClick={() => doSign.mutate(r.id)} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"><Check className="h-3.5 w-3.5" /> {t('mine.confirmSign')}</button>
                  </div>
                </div>
              )}

              {declining === r.id && (
                <div className="mt-3 space-y-2 border-t border-border pt-3">
                  <p className="text-xs font-semibold">{t('mine.declineTitle')}</p>
                  <input type="text" placeholder={t('mine.declineReason')} value={declineReason} onChange={(e) => setDeclineReason(e.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setDeclining(null)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"><X className="h-3.5 w-3.5" /></button>
                    <button type="button" disabled={doDecline.isPending} onClick={() => doDecline.mutate(r.id)} className="rounded-md bg-rose-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">{t('mine.confirmDecline')}</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
