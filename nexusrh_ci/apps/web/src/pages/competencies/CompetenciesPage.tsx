import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GraduationCap, Plus, Trash2, Briefcase, GitCompare } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Tab = 'catalog' | 'profiles' | 'compare'
const BLOOM = [1, 2, 3, 4, 5, 6] as const

interface Competency { id: string; label: string; category: string | null; bloom_level: number }
interface JobProfile { id: string; title: string; mission: string | null; category: string | null; level: string | null; competency_count: string }
interface ProfileCompetency { id: string; competency_id: string; label: string; required_level: number; bloom_level: number }
interface JobProfileDetail extends JobProfile { competencies: ProfileCompetency[] }
interface CompareRow { competencyId: string; label: string; levelA: number | null; levelB: number | null; diff: number | null }

function BloomBadge({ level }: { level: number }) {
  const { t } = useTranslation('competencies')
  return <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{t(`bloom.${level}`)}</span>
}

export default function CompetenciesPage() {
  const { t } = useTranslation('competencies')
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('catalog')

  // ── Catalogue ──
  const catalogQ = useQuery({
    queryKey: ['competencies', 'catalog'],
    queryFn: async () => (await api.get('/competencies/catalog')).data.data as Competency[],
  })
  const [cForm, setCForm] = useState({ label: '', category: '', bloomLevel: 3 })
  const createComp = useMutation({
    mutationFn: async () => { await api.post('/competencies/catalog', { label: cForm.label, category: cForm.category || undefined, bloomLevel: cForm.bloomLevel }) },
    onSuccess: () => { setCForm({ label: '', category: '', bloomLevel: 3 }); qc.invalidateQueries({ queryKey: ['competencies', 'catalog'] }) },
  })
  const deleteComp = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/competencies/catalog/${id}`) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['competencies', 'catalog'] }),
  })

  // ── Fiches de poste ──
  const profilesQ = useQuery({
    queryKey: ['competencies', 'profiles'],
    queryFn: async () => (await api.get('/competencies/job-profiles')).data.data as JobProfile[],
  })
  const [pForm, setPForm] = useState({ title: '', mission: '', category: '', level: '' })
  const [openProfile, setOpenProfile] = useState<string | null>(null)
  const createProfile = useMutation({
    mutationFn: async () => { await api.post('/competencies/job-profiles', { title: pForm.title, mission: pForm.mission || undefined, category: pForm.category || undefined, level: pForm.level || undefined }) },
    onSuccess: () => { setPForm({ title: '', mission: '', category: '', level: '' }); qc.invalidateQueries({ queryKey: ['competencies', 'profiles'] }) },
  })
  const deleteProfile = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/competencies/job-profiles/${id}`) },
    onSuccess: () => { setOpenProfile(null); qc.invalidateQueries({ queryKey: ['competencies', 'profiles'] }) },
  })
  const detailQ = useQuery({
    queryKey: ['competencies', 'profile', openProfile],
    enabled: !!openProfile,
    queryFn: async () => (await api.get(`/competencies/job-profiles/${openProfile}`)).data.data as JobProfileDetail,
  })
  const [attach, setAttach] = useState({ competencyId: '', requiredLevel: 3 })
  const addReq = useMutation({
    mutationFn: async (profileId: string) => { await api.post(`/competencies/job-profiles/${profileId}/competencies`, attach) },
    onSuccess: () => { setAttach({ competencyId: '', requiredLevel: 3 }); if (openProfile) qc.invalidateQueries({ queryKey: ['competencies', 'profile', openProfile] }); qc.invalidateQueries({ queryKey: ['competencies', 'profiles'] }) },
  })
  const removeReq = useMutation({
    mutationFn: async ({ profileId, linkId }: { profileId: string; linkId: string }) => { await api.delete(`/competencies/job-profiles/${profileId}/competencies/${linkId}`) },
    onSuccess: () => { if (openProfile) qc.invalidateQueries({ queryKey: ['competencies', 'profile', openProfile] }); qc.invalidateQueries({ queryKey: ['competencies', 'profiles'] }) },
  })

  // ── Comparateur ──
  const [cmp, setCmp] = useState({ a: '', b: '' })
  const compareQ = useQuery({
    queryKey: ['competencies', 'compare', cmp.a, cmp.b],
    enabled: !!cmp.a && !!cmp.b,
    queryFn: async () => (await api.get(`/competencies/compare?a=${cmp.a}&b=${cmp.b}`)).data.data.rows as CompareRow[],
  })

  const TabBtn = ({ value, label }: { value: Tab; label: string }) => (
    <button type="button" onClick={() => setTab(value)}
      className={cn('rounded-lg px-3 py-1.5 text-sm font-medium', tab === value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent')}>
      {label}
    </button>
  )

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><GraduationCap className="h-5 w-5" /></div>
        <div>
          <h1 className="text-xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      <div className="flex gap-1.5 rounded-xl border border-border bg-muted/40 p-1 w-fit">
        <TabBtn value="catalog" label={t('tabs.catalog')} />
        <TabBtn value="profiles" label={t('tabs.profiles')} />
        <TabBtn value="compare" label={t('tabs.compare')} />
      </div>

      {/* ── Onglet Compétences ── */}
      {tab === 'catalog' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">{t('catalog.new')}</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <input type="text" placeholder={t('catalog.fields.label')} value={cForm.label}
                onChange={e => setCForm(f => ({ ...f, label: e.target.value }))}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm sm:col-span-2" />
              <input type="text" placeholder={t('catalog.fields.category')} value={cForm.category}
                onChange={e => setCForm(f => ({ ...f, category: e.target.value }))}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
              <select value={cForm.bloomLevel} onChange={e => setCForm(f => ({ ...f, bloomLevel: Number(e.target.value) }))}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                {BLOOM.map(n => <option key={n} value={n}>{t(`bloom.${n}`)}</option>)}
              </select>
            </div>
            <div className="mt-2 flex justify-end">
              <button type="button" disabled={!cForm.label.trim() || createComp.isPending} onClick={() => createComp.mutate()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                <Plus className="h-4 w-4" /> {t('catalog.add')}
              </button>
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card divide-y divide-border">
            {(catalogQ.data?.length ?? 0) === 0 && <p className="py-10 text-center text-sm text-muted-foreground">{t('catalog.empty')}</p>}
            {(catalogQ.data ?? []).map(c => (
              <div key={c.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                <div>
                  <p className="text-sm font-medium">{c.label}</p>
                  {c.category && <p className="text-xs text-muted-foreground">{c.category}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <BloomBadge level={c.bloom_level} />
                  <button type="button" onClick={() => { if (window.confirm(t('catalog.deleteConfirm'))) deleteComp.mutate(c.id) }}
                    className="rounded-md p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Onglet Fiches de poste ── */}
      {tab === 'profiles' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">{t('profiles.new')}</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input type="text" placeholder={t('profiles.fields.title')} value={pForm.title}
                onChange={e => setPForm(f => ({ ...f, title: e.target.value }))}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
              <input type="text" placeholder={t('profiles.fields.category')} value={pForm.category}
                onChange={e => setPForm(f => ({ ...f, category: e.target.value }))}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
              <input type="text" placeholder={t('profiles.fields.mission')} value={pForm.mission}
                onChange={e => setPForm(f => ({ ...f, mission: e.target.value }))}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm sm:col-span-2" />
            </div>
            <div className="mt-2 flex justify-end">
              <button type="button" disabled={!pForm.title.trim() || createProfile.isPending} onClick={() => createProfile.mutate()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                <Plus className="h-4 w-4" /> {t('catalog.add')}
              </button>
            </div>
          </div>
          {(profilesQ.data?.length ?? 0) === 0 && <p className="rounded-xl border border-border bg-card py-10 text-center text-sm text-muted-foreground">{t('profiles.empty')}</p>}
          {(profilesQ.data ?? []).map(p => (
            <div key={p.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <button type="button" className="flex items-center gap-2 text-left" onClick={() => setOpenProfile(o => o === p.id ? null : p.id)}>
                  <Briefcase className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="font-semibold">{p.title}</p>
                    <p className="text-xs text-muted-foreground">{p.category ?? '—'} · {t('profiles.count', { count: Number(p.competency_count) })}</p>
                  </div>
                </button>
                <button type="button" onClick={() => { if (window.confirm(t('profiles.deleteConfirm'))) deleteProfile.mutate(p.id) }}
                  className="rounded-md p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
              </div>
              {openProfile === p.id && (
                <div className="mt-3 border-t border-border pt-3">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('profiles.competencies')}</h3>
                  {(detailQ.data?.competencies?.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">{t('profiles.noCompetencies')}</p>}
                  <ul className="space-y-1.5">
                    {(detailQ.data?.competencies ?? []).map(rc => (
                      <li key={rc.id} className="flex items-center justify-between gap-2 text-sm">
                        <span>{rc.label}</span>
                        <div className="flex items-center gap-2">
                          <BloomBadge level={rc.required_level} />
                          <button type="button" onClick={() => removeReq.mutate({ profileId: p.id, linkId: rc.id })}
                            className="rounded-md p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <select value={attach.competencyId} onChange={e => setAttach(a => ({ ...a, competencyId: e.target.value }))}
                      className="rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                      <option value="">{t('compare.select')}</option>
                      {(catalogQ.data ?? []).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                    <select value={attach.requiredLevel} onChange={e => setAttach(a => ({ ...a, requiredLevel: Number(e.target.value) }))}
                      className="rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                      {BLOOM.map(n => <option key={n} value={n}>{t(`bloom.${n}`)}</option>)}
                    </select>
                    <button type="button" disabled={!attach.competencyId || addReq.isPending} onClick={() => addReq.mutate(p.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                      <Plus className="h-4 w-4" /> {t('profiles.addCompetency')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Onglet Comparer ── */}
      {tab === 'compare' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('compare.profileA')}</label>
                <select value={cmp.a} onChange={e => setCmp(c => ({ ...c, a: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                  <option value="">{t('compare.select')}</option>
                  {(profilesQ.data ?? []).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('compare.profileB')}</label>
                <select value={cmp.b} onChange={e => setCmp(c => ({ ...c, b: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                  <option value="">{t('compare.select')}</option>
                  {(profilesQ.data ?? []).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
            </div>
          </div>
          {(!cmp.a || !cmp.b) && <p className="rounded-xl border border-border bg-card py-8 text-center text-sm text-muted-foreground">{t('compare.empty')}</p>}
          {cmp.a && cmp.b && (
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"><GitCompare className="h-3.5 w-3.5" /> {t('compare.diffHint')}</p>
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-2 py-1.5">{t('compare.competency')}</th>
                  <th className="px-2 py-1.5">{t('compare.profileA')}</th>
                  <th className="px-2 py-1.5">{t('compare.profileB')}</th>
                  <th className="px-2 py-1.5">Δ</th>
                </tr></thead>
                <tbody>
                  {(compareQ.data ?? []).map(r => (
                    <tr key={r.competencyId} className="border-b border-border/60 last:border-0">
                      <td className="px-2 py-1.5 font-medium">{r.label}</td>
                      <td className="px-2 py-1.5">{r.levelA ?? t('compare.notRequired')}</td>
                      <td className="px-2 py-1.5">{r.levelB ?? t('compare.notRequired')}</td>
                      <td className={cn('px-2 py-1.5 font-semibold', r.diff != null && r.diff > 0 && 'text-amber-600', r.diff != null && r.diff < 0 && 'text-emerald-600')}>
                        {r.diff != null ? (r.diff > 0 ? `+${r.diff}` : r.diff) : t('compare.notRequired')}
                      </td>
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
