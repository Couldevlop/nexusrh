import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import {
  Receipt, Upload, RefreshCw, Save, CheckCircle2, GripVertical, Eye, Globe, Image as ImageIcon,
} from 'lucide-react'

// ── Modèle ────────────────────────────────────────────────────────────────────
interface Block { id: string; enabled: boolean; text?: string }
interface ScopeCfg {
  accentColor: string | null; logoAssetId: string | null
  showBaseColumn: boolean; showCodeColumn: boolean
  showEmployerCost: boolean; showAnnualCumuls: boolean
  footerText: string | null; blocks: Block[]
}
interface ApiResp {
  multiCountry: boolean; countries: string[]; defaultCountry: string
  defaultAccent: string; assetBase: string
  config: Partial<ScopeCfg> & { byCountry?: Record<string, Partial<ScopeCfg>> }
}

// Catalogue des blocs. `locked` = bloc légal obligatoire (non désactivable).
const BLOCKS: Record<string, { locked?: boolean; hasText?: boolean }> = {
  identity: { locked: true }, table: { locked: true }, recap: { locked: true }, net: { locked: true },
  employerCost: {}, payment: {}, cumuls: {}, freeText: { hasText: true },
}
const DEFAULT_BLOCKS: Block[] = [
  { id: 'identity', enabled: true }, { id: 'table', enabled: true },
  { id: 'recap', enabled: true }, { id: 'net', enabled: true },
  { id: 'employerCost', enabled: true }, { id: 'payment', enabled: true },
  { id: 'cumuls', enabled: true }, { id: 'freeText', enabled: false, text: '' },
]

function normalizeScope(s: Partial<ScopeCfg> | undefined, defaultAccent: string): ScopeCfg {
  const blocks = Array.isArray(s?.blocks) && s!.blocks!.length
    ? (s!.blocks as Block[]).map(b => ({ ...b }))
    : DEFAULT_BLOCKS.map(b => ({ ...b }))
  // Garantit la présence de tous les blocs du catalogue (les nouveaux en queue).
  for (const id of Object.keys(BLOCKS)) {
    if (!blocks.some(b => b.id === id)) blocks.push({ id, enabled: false, text: BLOCKS[id]?.hasText ? '' : undefined })
  }
  return {
    accentColor: s?.accentColor ?? defaultAccent,
    logoAssetId: s?.logoAssetId ?? null,
    showBaseColumn: s?.showBaseColumn !== false,
    showCodeColumn: s?.showCodeColumn !== false,
    showEmployerCost: s?.showEmployerCost !== false,
    showAnnualCumuls: s?.showAnnualCumuls !== false,
    footerText: s?.footerText ?? null,
    blocks,
  }
}

export default function PayslipBuilder() {
  const { t } = useTranslation('settings')
  const qc = useQueryClient()
  const role = useAuthStore(s => s.user?.role ?? '')
  const canEdit = role === 'admin'

  const { data: resp } = useQuery<{ data: ApiResp }>({
    queryKey: ['settings-payslip-template'],
    queryFn: () => api.get('/settings/payslip-template').then(r => r.data),
  })

  const [model, setModel] = useState<{ group: ScopeCfg; byCountry: Record<string, ScopeCfg> } | null>(null)
  const [scope, setScope] = useState('group')
  const [uploading, setUploading] = useState(false)
  const [saved, setSaved] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const dragIndex = useRef<number | null>(null)

  // Initialise le modèle au chargement.
  useEffect(() => {
    if (!resp?.data || model) return
    const d = resp.data
    const byCountry: Record<string, ScopeCfg> = {}
    for (const [c, sc] of Object.entries(d.config.byCountry ?? {})) byCountry[c] = normalizeScope(sc, d.defaultAccent)
    setModel({ group: normalizeScope(d.config, d.defaultAccent), byCountry })
  }, [resp, model])

  const meta = resp?.data
  const active: ScopeCfg | undefined = !model ? undefined : scope === 'group' ? model.group : model.byCountry[scope]

  function patch(p: Partial<ScopeCfg>) {
    setModel(m => {
      if (!m) return m
      if (scope === 'group') return { ...m, group: { ...m.group, ...p } }
      const base = m.byCountry[scope] ?? { ...m.group, blocks: m.group.blocks.map(b => ({ ...b })) }
      return { ...m, byCountry: { ...m.byCountry, [scope]: { ...base, ...p } } }
    })
  }
  function selectScope(s: string) {
    // À l'ouverture d'un pays sans modèle, on l'initialise depuis le Groupe.
    if (s !== 'group') {
      setModel(m => (m && !m.byCountry[s])
        ? { ...m, byCountry: { ...m.byCountry, [s]: { ...m.group, blocks: m.group.blocks.map(b => ({ ...b })) } } } : m)
    }
    setScope(s)
  }

  // Aperçu PDF live (debounce) du scope courant.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const handle = setTimeout(async () => {
      setPreviewing(true)
      try {
        const res = await api.post('/settings/payslip-template/preview', {
          accentColor: active.accentColor, logoAssetId: active.logoAssetId,
          showBaseColumn: active.showBaseColumn, showCodeColumn: active.showCodeColumn,
          showEmployerCost: active.showEmployerCost, showAnnualCumuls: active.showAnnualCumuls,
          footerText: active.footerText, blocks: active.blocks,
        }, { responseType: 'blob' })
        if (cancelled) return
        const url = URL.createObjectURL(res.data as Blob)
        setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url })
      } catch { /* aperçu best-effort */ } finally { if (!cancelled) setPreviewing(false) }
    }, 600)
    return () => { cancelled = true; clearTimeout(handle) }
  }, [active])

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!model) return
      const body: Record<string, unknown> = { ...model.group }
      if (meta?.multiCountry && Object.keys(model.byCountry).length) body.byCountry = model.byCountry
      await api.put('/settings/payslip-template', body)
    },
    onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2500); qc.invalidateQueries({ queryKey: ['settings-payslip-template'] }) },
  })

  async function handleLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData(); fd.append('file', file)
      const res = await api.post('/settings/payslip-template/logo', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      patch({ logoAssetId: (res.data as { data: { logoAssetId: string } }).data.logoAssetId })
    } finally { setUploading(false); e.target.value = '' }
  }

  // Réordonnancement par glisser-déposer (setData obligatoire Firefox ; pas de
  // setState dans dragStart pour ne pas avorter le drag sous Chromium).
  function onDrop(toIdx: number) {
    const from = dragIndex.current
    dragIndex.current = null
    if (from == null || from === toIdx || !active) return
    const blocks = active.blocks.slice()
    const [moved] = blocks.splice(from, 1)
    if (!moved) return
    blocks.splice(toIdx, 0, moved)
    patch({ blocks })
  }
  function toggleBlock(idx: number, on: boolean) {
    const blocks = active!.blocks.slice()
    const b = blocks[idx]; if (!b) return
    blocks[idx] = { ...b, enabled: on }; patch({ blocks })
  }
  function setBlockText(idx: number, text: string) {
    const blocks = active!.blocks.slice()
    const b = blocks[idx]; if (!b) return
    blocks[idx] = { ...b, text }; patch({ blocks })
  }

  if (!model || !active || !meta) return <div className="p-6 text-sm text-muted-foreground">{t('loading', 'Chargement…')}</div>

  const logoUrl = active.logoAssetId ? `${meta.assetBase}${active.logoAssetId}` : null

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Receipt className="h-5 w-5 text-primary" />
        <div>
          <h2 className="font-semibold">{t('payslipTemplate.title', 'Constructeur de bulletin')}</h2>
          <p className="text-xs text-muted-foreground">{t('payslipTemplate.subtitle', 'Assemblez le bulletin : glissez les blocs, activez/désactivez, personnalisez le logo et les couleurs. Aperçu en direct.')}</p>
        </div>
      </div>

      {/* Portée : Groupe + pays (auto-détecté). Masqué si mono-pays. */}
      {meta.multiCountry && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/30 p-2">
          <span className="flex items-center gap-1 px-2 text-xs font-medium text-muted-foreground"><Globe className="h-3.5 w-3.5" /> {t('payslipTemplate.scope', 'Portée')}</span>
          {['group', ...meta.countries].map(s => (
            <button key={s} onClick={() => selectScope(s)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${scope === s ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {s === 'group' ? t('payslipTemplate.scopeGroup', 'Groupe') : s}
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Colonne édition */}
        <div className="space-y-4">
          {/* Blocs */}
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="mb-2 text-sm font-semibold">{t('payslipTemplate.blocks', 'Blocs du bulletin (glisser pour réordonner)')}</h3>
            <ul className="space-y-1.5">
              {active.blocks.map((b, idx) => {
                const meta2 = BLOCKS[b.id] ?? {}
                return (
                  <li key={b.id}
                    draggable={canEdit}
                    onDragStart={e => { dragIndex.current = idx; e.dataTransfer.setData('text/plain', String(idx)); e.dataTransfer.effectAllowed = 'move' }}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => onDrop(idx)}
                    className="rounded-lg border border-border bg-background px-3 py-2">
                    <div className="flex items-center gap-2">
                      <GripVertical className={`h-4 w-4 shrink-0 ${canEdit ? 'cursor-grab text-muted-foreground' : 'text-muted'}`} />
                      <span className="flex-1 text-sm">{t(`payslipTemplate.block.${b.id}`, b.id)}</span>
                      {meta2.locked
                        ? <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{t('payslipTemplate.required', 'obligatoire')}</span>
                        : <input type="checkbox" disabled={!canEdit} checked={b.enabled} onChange={e => toggleBlock(idx, e.target.checked)} className="h-4 w-4 accent-primary" />}
                    </div>
                    {meta2.hasText && b.enabled && (
                      <textarea disabled={!canEdit} rows={2} maxLength={2000} value={b.text ?? ''}
                        onChange={e => setBlockText(idx, e.target.value)}
                        placeholder={t('payslipTemplate.freeTextPlaceholder', 'Texte libre (mention, message RH…)')}
                        className="mt-2 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring" />
                    )}
                  </li>
                )
              })}
            </ul>
          </div>

          {/* Logo + couleur + colonnes + pied de page */}
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-center gap-3">
              {logoUrl
                ? <img src={logoUrl} alt="logo" className="h-12 max-w-[140px] rounded border border-border bg-white object-contain p-1" />
                : <div className="flex h-12 w-12 items-center justify-center rounded border border-dashed border-border text-muted-foreground"><ImageIcon className="h-5 w-5" /></div>}
              {canEdit && (
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm hover:bg-accent">
                  {uploading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {t('payslipTemplate.uploadLogo', 'Logo (PNG/JPEG)')}
                  <input type="file" accept="image/png,image/jpeg" onChange={handleLogo} className="hidden" />
                </label>
              )}
              {logoUrl && canEdit && (
                <button onClick={() => patch({ logoAssetId: null })} className="text-xs text-muted-foreground underline">{t('payslipTemplate.removeLogo', 'Retirer')}</button>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{t('payslipTemplate.accentColor', 'Couleur d\'accent')}</span>
              <input type="color" disabled={!canEdit} value={active.accentColor || '#E85D04'} onChange={e => patch({ accentColor: e.target.value })} className="h-8 w-14 rounded border border-border" />
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              {t('payslipTemplate.showBaseColumn', 'Colonne « Base »')}
              <input type="checkbox" disabled={!canEdit} checked={active.showBaseColumn} onChange={e => patch({ showBaseColumn: e.target.checked })} className="h-4 w-4 accent-primary" />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              {t('payslipTemplate.showCodeColumn', 'Code des rubriques')}
              <input type="checkbox" disabled={!canEdit} checked={active.showCodeColumn} onChange={e => patch({ showCodeColumn: e.target.checked })} className="h-4 w-4 accent-primary" />
            </label>
            <div>
              <label className="mb-1 block text-sm font-medium">{t('payslipTemplate.footerText', 'Mention de pied de page')}</label>
              <textarea disabled={!canEdit} rows={2} maxLength={400} value={active.footerText ?? ''}
                onChange={e => patch({ footerText: e.target.value || null })}
                placeholder={t('payslipTemplate.footerPlaceholder', 'Vide = mention légale CI par défaut.')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
            </div>
          </div>

          {canEdit && (
            <div className="flex items-center gap-3">
              <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                <Save className="h-4 w-4" /> {t('save', 'Enregistrer')}
              </button>
              {saved && <span className="flex items-center gap-1 text-sm text-emerald-600"><CheckCircle2 className="h-4 w-4" /> {t('saved', 'Enregistré')}</span>}
            </div>
          )}
        </div>

        {/* Colonne aperçu live */}
        <div className="rounded-xl border border-border bg-muted/20 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Eye className="h-4 w-4" /> {t('payslipTemplate.preview', 'Aperçu en direct')}
            {previewing && <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          {previewUrl
            ? <iframe title="apercu-bulletin" src={previewUrl} className="h-[640px] w-full rounded-lg border border-border bg-white" />
            : <div className="flex h-[640px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">{t('payslipTemplate.previewLoading', 'Génération de l\'aperçu…')}</div>}
        </div>
      </div>
    </div>
  )
}
