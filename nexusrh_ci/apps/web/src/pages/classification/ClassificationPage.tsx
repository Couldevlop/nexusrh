import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Layers, Plus, Trash2, Pencil, Check, X, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'

type Tab = 'levels' | 'categories'
const TENANT_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly', 'dg', 'raf_site'] as const

interface LevelRow {
  level: number
  label: string
  allowed_roles: string[]
  export_allowed: boolean
  encryption_required: boolean
  audit_required: boolean
}
interface CategoryRow {
  id: string
  category_key: string
  label: string
  level: number
  examples: string | null
}

const LEVEL_STYLE: Record<number, string> = {
  1: 'bg-emerald-100 text-emerald-800',
  2: 'bg-sky-100 text-sky-800',
  3: 'bg-amber-100 text-amber-800',
  4: 'bg-rose-100 text-rose-800',
}

export default function ClassificationPage() {
  const { t } = useTranslation('classification')
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role ?? '')
  const canConfigureLevels = role === 'admin'
  const canEditCategories = role === 'admin' || role === 'hr_manager'
  const [tab, setTab] = useState<Tab>('levels')

  const levelsQ = useQuery({
    queryKey: ['classification', 'levels'],
    queryFn: async () => (await api.get('/classification/levels')).data.data as LevelRow[],
  })
  const categoriesQ = useQuery({
    queryKey: ['classification', 'categories'],
    queryFn: async () => (await api.get('/classification/categories')).data.data as CategoryRow[],
  })

  // ── Édition d'un niveau ──
  const [editLevel, setEditLevel] = useState<number | null>(null)
  const [draft, setDraft] = useState<{ allowedRoles: string[]; exportAllowed: boolean; encryptionRequired: boolean; auditRequired: boolean } | null>(null)
  const startEdit = (l: LevelRow) => {
    setEditLevel(l.level)
    setDraft({ allowedRoles: [...(l.allowed_roles ?? [])], exportAllowed: l.export_allowed, encryptionRequired: l.encryption_required, auditRequired: l.audit_required })
  }
  const saveLevel = useMutation({
    mutationFn: async () => { await api.put(`/classification/levels/${editLevel}`, draft) },
    onSuccess: () => { setEditLevel(null); setDraft(null); qc.invalidateQueries({ queryKey: ['classification', 'levels'] }) },
  })
  const toggleRole = (r: string) => setDraft((d) => d ? { ...d, allowedRoles: d.allowedRoles.includes(r) ? d.allowedRoles.filter((x) => x !== r) : [...d.allowedRoles, r] } : d)

  // ── Catégories ──
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ categoryKey: '', label: '', level: 2, examples: '' })
  const createCat = useMutation({
    mutationFn: async () => { await api.post('/classification/categories', { categoryKey: form.categoryKey, label: form.label, level: form.level, examples: form.examples || undefined }) },
    onSuccess: () => { setShowForm(false); setForm({ categoryKey: '', label: '', level: 2, examples: '' }); qc.invalidateQueries({ queryKey: ['classification', 'categories'] }) },
  })
  const patchCat = useMutation({
    mutationFn: async ({ id, level }: { id: string; level: number }) => { await api.patch(`/classification/categories/${id}`, { level }) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['classification', 'categories'] }),
  })
  const deleteCat = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/classification/categories/${id}`) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['classification', 'categories'] }),
  })

  const levelName = (l: number) => t(`levelNames.${l}`, { defaultValue: String(l) })
  const TabBtn = ({ value, label }: { value: Tab; label: string }) => (
    <button type="button" onClick={() => setTab(value)}
      className={cn('rounded-lg px-3 py-1.5 text-sm font-medium', tab === value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent')}>{label}</button>
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Layers className="h-5 w-5" /></div>
        <div>
          <h1 className="text-xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      <div className="flex w-fit gap-1.5 rounded-xl border border-border bg-muted/40 p-1">
        <TabBtn value="levels" label={t('tabs.levels')} />
        <TabBtn value="categories" label={t('tabs.categories')} />
      </div>

      {/* ── Niveaux ── */}
      {tab === 'levels' && (
        <div className="space-y-4">
          <p className="max-w-3xl text-sm text-muted-foreground">{t('levels.intro')}</p>
          {!canConfigureLevels && (
            <p className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-xs text-muted-foreground"><ShieldAlert className="h-3.5 w-3.5" /> {t('levels.readOnlyHint')}</p>
          )}
          {levelsQ.isError && <p className="text-sm text-destructive">{t('loadError')}</p>}
          <div className="space-y-3">
            {(levelsQ.data ?? []).map((l) => {
              const editing = editLevel === l.level && draft
              return (
                <div key={l.level} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', LEVEL_STYLE[l.level] ?? 'bg-muted')}>{l.level} · {levelName(l.level)}</span>
                    </div>
                    {canConfigureLevels && !editing && (
                      <button type="button" onClick={() => startEdit(l)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"><Pencil className="h-3.5 w-3.5" /> {t('levels.edit')}</button>
                    )}
                    {editing && (
                      <div className="flex gap-1.5">
                        <button type="button" disabled={saveLevel.isPending} onClick={() => saveLevel.mutate()} className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"><Check className="h-3.5 w-3.5" /> {saveLevel.isPending ? t('levels.saving') : t('levels.save')}</button>
                        <button type="button" onClick={() => { setEditLevel(null); setDraft(null) }} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"><X className="h-3.5 w-3.5" /> {t('levels.cancel')}</button>
                      </div>
                    )}
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">{t('levels.allowedRoles')}</p>
                      {editing ? (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {TENANT_ROLES.map((r) => (
                            <button key={r} type="button" onClick={() => toggleRole(r)}
                              className={cn('rounded-full border px-2 py-0.5 text-[11px]', draft.allowedRoles.includes(r) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent')}>
                              {t(`roles.${r}`, { defaultValue: r })}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {(l.allowed_roles ?? []).length === 0 ? <span className="text-sm text-muted-foreground">—</span> :
                            (l.allowed_roles ?? []).map((r) => <span key={r} className="rounded-full bg-muted px-2 py-0.5 text-[11px]">{t(`roles.${r}`, { defaultValue: r })}</span>)}
                        </div>
                      )}
                    </div>
                    <div className="space-y-1.5 text-sm">
                      <Flag label={t('levels.exportAllowed')} value={editing ? draft.exportAllowed : l.export_allowed} editable={!!editing} onChange={(v) => setDraft((d) => d ? { ...d, exportAllowed: v } : d)} yes={t('levels.yes')} no={t('levels.no')} />
                      <Flag label={t('levels.encryptionRequired')} value={editing ? draft.encryptionRequired : l.encryption_required} editable={!!editing} onChange={(v) => setDraft((d) => d ? { ...d, encryptionRequired: v } : d)} yes={t('levels.yes')} no={t('levels.no')} />
                      <Flag label={t('levels.auditRequired')} value={editing ? draft.auditRequired : l.audit_required} editable={!!editing} onChange={(v) => setDraft((d) => d ? { ...d, auditRequired: v } : d)} yes={t('levels.yes')} no={t('levels.no')} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Catégories ── */}
      {tab === 'categories' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="max-w-3xl text-sm text-muted-foreground">{t('categories.intro')}</p>
            {canEditCategories && (
              <button type="button" onClick={() => setShowForm((s) => !s)} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90">
                <Plus className="h-4 w-4" /> {t('categories.new')}
              </button>
            )}
          </div>

          {showForm && canEditCategories && (
            <div className="max-w-2xl rounded-xl border border-border bg-card p-4 space-y-2">
              <input type="text" placeholder={t('categories.key')} value={form.categoryKey} onChange={(e) => setForm((f) => ({ ...f, categoryKey: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
              <p className="text-[11px] text-muted-foreground">{t('categories.keyHint')}</p>
              <input type="text" placeholder={t('categories.label')} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
              <select value={form.level} onChange={(e) => setForm((f) => ({ ...f, level: Number(e.target.value) }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} · {levelName(n)}</option>)}
              </select>
              <input type="text" placeholder={t('categories.examples')} value={form.examples} onChange={(e) => setForm((f) => ({ ...f, examples: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
              <div className="flex justify-end">
                <button type="button" disabled={!form.categoryKey || !form.label || createCat.isPending} onClick={() => createCat.mutate()}
                  className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                  {createCat.isPending ? t('categories.creating') : t('categories.create')}
                </button>
              </div>
            </div>
          )}

          {(categoriesQ.data?.length ?? 0) === 0 && <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('categories.empty')}</p>}

          {(categoriesQ.data?.length ?? 0) > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2">{t('categories.label')}</th>
                  <th className="px-3 py-2">{t('categories.level')}</th>
                  <th className="px-3 py-2">{t('categories.examples')}</th>
                  {canEditCategories && <th className="px-3 py-2" />}
                </tr></thead>
                <tbody>
                  {(categoriesQ.data ?? []).map((c) => (
                    <tr key={c.id} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2">
                        <p className="font-medium">{c.label}</p>
                        <p className="text-[11px] text-muted-foreground">{c.category_key}</p>
                      </td>
                      <td className="px-3 py-2">
                        {canEditCategories ? (
                          <select value={c.level} onChange={(e) => patchCat.mutate({ id: c.id, level: Number(e.target.value) })}
                            className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', LEVEL_STYLE[c.level] ?? 'bg-muted')}>
                            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} · {levelName(n)}</option>)}
                          </select>
                        ) : (
                          <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', LEVEL_STYLE[c.level] ?? 'bg-muted')}>{c.level} · {levelName(c.level)}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{c.examples ?? '—'}</td>
                      {canEditCategories && (
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => { if (window.confirm(t('categories.deleteConfirm'))) deleteCat.mutate(c.id) }} className="rounded-md p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                        </td>
                      )}
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

function Flag({ label, value, editable, onChange, yes, no }: { label: string; value: boolean; editable: boolean; onChange: (v: boolean) => void; yes: string; no: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {editable ? (
        <button type="button" onClick={() => onChange(!value)}
          className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', value ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground')}>
          {value ? yes : no}
        </button>
      ) : (
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', value ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground')}>{value ? yes : no}</span>
      )}
    </div>
  )
}
