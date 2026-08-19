/**
 * Formats de fichier bancaire — paramétrage par le tenant.
 *
 * Chaque banque impose son gabarit. L'admin part d'un modèle ou dépose le
 * fichier exemple de sa banque (dont on ne garde que la structure), ajuste le
 * mapping colonne → donnée NexusRH, vérifie l'aperçu sur une paie réelle, puis
 * ACTIVE. Un profil actif n'est jamais modifié en place : l'édition prépare la
 * version suivante en brouillon.
 */
import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, formatFCFA } from '@/lib/api'
import {
  Landmark, Plus, Upload, Eye, CheckCircle2, AlertCircle, Loader2, Trash2,
  ArrowUp, ArrowDown, Download, FileText,
} from 'lucide-react'

interface Segment {
  label?: string
  source: string
  literal?: string
  transform?: string[]
  pad?: { width: number; align: 'left' | 'right'; char: string }
  truncate?: number
  dateFormat?: string
  amountScale?: number
}
interface Spec {
  output: 'xlsx' | 'csv' | 'fixed'
  encoding: 'utf8' | 'latin1'
  delimiter: string
  lineEnding: 'crlf' | 'lf'
  filename: string
  header: { mode: 'none' | 'labels' | 'custom'; lines: Segment[][] }
  columns: Segment[]
  footer: { enabled: boolean; lines: Segment[][] }
}
interface TemplateRow {
  id: string; bank: string; version: number; status: 'draft' | 'active' | 'archived'
  label: string | null; outputKind: string; sampleFilename: string | null; activatedAt: string | null
}
interface DirectoryRow { bank: string; email: string | null; orderingAccount: string | null; orderingLabel: string | null }
interface Referential {
  sources: Array<{ value: string; group: string; label: string }>
  transforms: string[]; dateFormats: string[]; outputs: string[]; encodings: string[]; delimiters: string[]
  presets: Array<{ key: string; label: string; description: string; output: string }>
  maxColumns: number; maxSampleBytes: number
}
interface TemplatesResponse { data: TemplateRow[]; directory: DirectoryRow[]; employeeBanks?: string[]; referential: Referential }
interface TemplateDetail { id: string; bank: string; version: number; status: string; label: string | null; spec: Spec; issues: string[] }
interface PreviewResult {
  bank: string; version: number; issues: string[]; filename: string; outputKind: string
  rowCount: number; previewRows: number; totalAmount: number
  table: string[][]; lines: string[] | null
}
interface SampleAnalysis {
  filename: string; output: Spec['output']; encoding: Spec['encoding']; delimiter?: string
  columns: Segment[]; unmappedCount: number; linesRead: number; truncated: boolean
}

const GROUP_LABEL: Record<string, string> = {
  employee: 'Salarié', payslip: 'Paie', orderer: 'Donneur d\'ordre', computed: 'Calculé', literal: 'Texte fixe',
  blank: 'Sans donnée NexusRH',
}
const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700',
  draft: 'bg-amber-100 text-amber-700',
  archived: 'bg-muted text-muted-foreground',
}

function emptySpec(output: Spec['output']): Spec {
  return {
    output, encoding: output === 'fixed' ? 'latin1' : 'utf8', delimiter: ';', lineEnding: 'crlf',
    filename: `VIR_{banque}_{mois}.${output === 'fixed' ? 'txt' : output === 'csv' ? 'csv' : 'xlsx'}`,
    header: { mode: output === 'fixed' ? 'none' : 'labels', lines: [] },
    columns: [], footer: { enabled: false, lines: [] },
  }
}

export default function BankFormatsSection() {
  const { t } = useTranslation('mobileMoney')
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const { data, isLoading, refetch } = useQuery<TemplatesResponse>({
    queryKey: ['bank-templates'],
    queryFn: () => api.get('/bank-transfer/templates').then(r => r.data),
  })

  const templates = data?.data ?? []
  const banks = Array.from(new Set([...templates.map(x => x.bank), ...(data?.directory ?? []).map(d => d.bank)])).sort()

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-1 flex items-center gap-2">
          <FileText className="h-4 w-4" /> {t('bankFormats.title', 'Formats de fichier bancaire')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('bankFormats.subtitle', 'Chaque banque impose son propre format. Décrivez ici celui de votre banque : sans profil actif, NexusRH envoie son gabarit Excel standard.')}
        </p>
        <button onClick={() => setCreating(v => !v)}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" /> {t('bankFormats.new', 'Nouveau format')}
        </button>
      </div>

      {creating && data && (
        <CreateTemplate referential={data.referential} knownBanks={banks} employeeBanks={data.employeeBanks ?? []}
          onDone={(id) => { setCreating(false); setOpenId(id); void refetch() }} />
      )}

      {isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}

      {!isLoading && templates.length === 0 && (
        <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {t('bankFormats.empty', 'Aucun format défini — les fichiers sont générés au gabarit Excel standard de NexusRH.')}
        </p>
      )}

      {banks.filter(b => templates.some(x => x.bank === b)).map(bank => (
        <div key={bank} className="rounded-xl border border-border bg-card p-6">
          <h3 className="font-medium flex items-center gap-2 mb-3"><Landmark className="h-4 w-4" /> {bank}</h3>
          <div className="space-y-2">
            {templates.filter(x => x.bank === bank).map(tpl => (
              <div key={tpl.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[tpl.status]}`}>
                  {t(`bankFormats.status.${tpl.status}`, tpl.status)}
                </span>
                <span className="font-medium">v{tpl.version}</span>
                <span className="text-muted-foreground">{tpl.label ?? '—'}</span>
                <span className="rounded bg-muted px-2 py-0.5 text-xs uppercase">{tpl.outputKind}</span>
                {tpl.sampleFilename && <span className="text-xs text-muted-foreground">{tpl.sampleFilename}</span>}
                <button onClick={() => setOpenId(openId === tpl.id ? null : tpl.id)}
                  className="ml-auto rounded-lg border border-input px-3 py-1 text-xs hover:bg-muted">
                  {openId === tpl.id ? t('bankFormats.close', 'Fermer') : t('bankFormats.open', 'Ouvrir')}
                </button>
              </div>
            ))}
          </div>
          {openId && templates.some(x => x.id === openId && x.bank === bank) && data && (
            <TemplateEditor id={openId} referential={data.referential}
              knownBanks={banks} employeeBanks={data.employeeBanks ?? []}
              onChanged={(newId) => { if (newId) setOpenId(newId); void refetch() }} />
          )}
        </div>
      ))}
    </div>
  )
}

/** Création : modèle de départ, ou dépôt du fichier exemple de la banque. */
function CreateTemplate({ referential, knownBanks, employeeBanks, onDone }: {
  referential: Referential; knownBanks: string[]; employeeBanks: string[]; onDone: (id: string) => void
}) {
  const { t } = useTranslation('mobileMoney')
  const [bank, setBank] = useState('')
  const [presetKey, setPresetKey] = useState(referential.presets[0]?.key ?? '')
  const [analysis, setAnalysis] = useState<SampleAnalysis | null>(null)
  const [error, setError] = useState<string | null>(null)

  const importMut = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append('file', file)
      // L'en-tête est OBLIGATOIRE : l'instance axios pose 'application/json' par
      // défaut, et axios v1 sérialise alors le FormData en JSON — le serveur ne
      // recevrait aucun fichier. Même contrainte que les autres uploads du web.
      return api.post<{ data: SampleAnalysis }>('/bank-transfer/templates/import', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }).then(r => r.data.data)
    },
    onSuccess: (res) => { setAnalysis(res); setError(null) },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      setError(e.response?.data?.error ?? t('bankFormats.importError', 'Fichier illisible.')),
  })

  const createMut = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { bank }
      if (analysis) {
        const spec = emptySpec(analysis.output)
        spec.encoding = analysis.encoding
        if (analysis.delimiter) spec.delimiter = analysis.delimiter
        spec.columns = analysis.columns
        body.spec = spec
        body.sampleFilename = analysis.filename
        body.label = `${bank} — ${analysis.filename}`
      } else {
        body.presetKey = presetKey
      }
      return api.post<{ data: { id: string } }>('/bank-transfer/templates', body).then(r => r.data.data)
    },
    onSuccess: (res) => onDone(res.id),
    onError: (e: { response?: { data?: { error?: string } } }) =>
      setError(e.response?.data?.error ?? t('bankFormats.createError', 'Création impossible.')),
  })

  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-4">
      <div>
        <label className="text-sm font-medium mb-1 block">{t('bankFormats.bank', 'Banque')}</label>
        <input list="known-banks" value={bank} onChange={e => setBank(e.target.value)} maxLength={100}
          placeholder={t('bankFormats.bankPlaceholder', 'Nom exact tel qu\'il figure sur les fiches salariés')}
          className="w-full max-w-md rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        <datalist id="known-banks">{knownBanks.map(b => <option key={b} value={b} />)}</datalist>
        {bank.trim().length > 0 && employeeBanks.length > 0 && !employeeBanks.includes(bank.trim()) && (
          <p className="mt-1 text-xs text-amber-700">
            {t('bankFormats.bankUnknown', 'Aucun salarié payé par virement n’a cette banque — le format ne s’appliquera à personne. Banques connues : {{list}}', { list: employeeBanks.join(', ') })}
          </p>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-border p-4">
          <h4 className="text-sm font-medium mb-2">{t('bankFormats.fromPreset', 'Partir d\'un modèle')}</h4>
          <select value={presetKey} onChange={e => { setPresetKey(e.target.value); setAnalysis(null) }}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
            {referential.presets.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <p className="mt-2 text-xs text-muted-foreground">
            {referential.presets.find(p => p.key === presetKey)?.description}
          </p>
        </div>

        <div className="rounded-lg border border-border p-4">
          <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
            <Upload className="h-4 w-4" /> {t('bankFormats.fromSample', 'Déposer le fichier exemple de la banque')}
          </h4>
          <input type="file" accept=".xlsx,.csv,.txt"
            onChange={e => { const f = e.target.files?.[0]; if (f) importMut.mutate(f) }}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm" />
          <p className="mt-2 text-xs text-muted-foreground">
            {t('bankFormats.sampleNote', 'Le fichier n\'est pas conservé : seule sa structure (colonnes ou positions) est lue. Max {{mb}} Mo.', { mb: Math.round(referential.maxSampleBytes / 1024 / 1024) })}
          </p>
          {importMut.isPending && <Loader2 className="mt-2 h-4 w-4 animate-spin" />}
          {analysis && (
            <p className="mt-2 text-xs">
              <CheckCircle2 className="inline h-3.5 w-3.5 text-emerald-600" />{' '}
              {t('bankFormats.sampleDetected', '{{n}} colonne(s) détectée(s), {{u}} à mapper.', { n: analysis.columns.length, u: analysis.unmappedCount })}
            </p>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-destructive flex items-center gap-2"><AlertCircle className="h-4 w-4" /> {error}</p>}

      <button disabled={!bank.trim() || createMut.isPending} onClick={() => createMut.mutate()}
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        {t('bankFormats.createDraft', 'Créer le brouillon')}
      </button>
    </div>
  )
}

/** Éditeur de mapping + aperçu + activation. */
function TemplateEditor({ id, referential, knownBanks, employeeBanks, onChanged }: {
  id: string; referential: Referential; knownBanks: string[]; employeeBanks: string[]
  onChanged: (newId?: string) => void
}) {
  const { t } = useTranslation('mobileMoney')
  const [spec, setSpec] = useState<Spec | null>(null)
  // Nom de banque en cours d'édition ; null tant qu'il n'a pas été touché.
  const [bankDraft, setBankDraft] = useState<string | null>(null)
  const [month, setMonth] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const { data: detail, refetch: refetchDetail } = useQuery<{ data: TemplateDetail }>({
    queryKey: ['bank-template', id],
    queryFn: () => api.get(`/bank-transfer/templates/${id}`).then(r => r.data),
  })
  const current = detail?.data
  const working = spec ?? current?.spec ?? null
  const readOnly = current?.status === 'archived'

  const saveMut = useMutation({
    mutationFn: () => api.put<{ data: { id: string; createdNewVersion: boolean; issues: string[] } }>(
      `/bank-transfer/templates/${id}`,
      { bank: bankDraft?.trim() || undefined, label: current?.label ?? undefined, spec: working },
    ).then(r => r.data.data),
    onSuccess: async (res) => {
      setMessage({ kind: 'ok', text: res.createdNewVersion
        ? t('bankFormats.savedNewVersion', 'Nouvelle version en brouillon — le format actif n\'a pas bougé.')
        : t('bankFormats.saved', 'Brouillon enregistré.') })
      // Relire AVANT d'abandonner l'état local : `working` retombe sur la
      // réponse du serveur, et une réponse périmée réafficherait l’ancien
      // mapping sous un message « Brouillon enregistré ».
      if (!res.createdNewVersion) await refetchDetail()
      setSpec(null)
      setBankDraft(null)
      onChanged(res.createdNewVersion ? res.id : undefined)
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      setMessage({ kind: 'error', text: e.response?.data?.error ?? t('bankFormats.saveError', 'Enregistrement impossible.') }),
  })

  const previewMut = useMutation({
    mutationFn: () => api.post<{ data: PreviewResult }>(`/bank-transfer/templates/${id}/preview`, { month }).then(r => r.data.data),
    onSuccess: (res) => { setPreview(res); setMessage(null) },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      setMessage({ kind: 'error', text: e.response?.data?.error ?? t('bankFormats.previewError', 'Aperçu impossible.') }),
  })

  const activateMut = useMutation({
    mutationFn: () => api.post(`/bank-transfer/templates/${id}/activate`),
    onSuccess: async () => {
      setMessage({ kind: 'ok', text: t('bankFormats.activated', 'Format activé — la version précédente est archivée.') })
      await refetchDetail()   // sinon le bandeau « Brouillon » reste sur un profil actif
      onChanged()
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      setMessage({ kind: 'error', text: e.response?.data?.error ?? t('bankFormats.activateError', 'Activation impossible.') }),
  })

  // Téléchargement via axios (et non un <a href>) : c'est l'intercepteur qui
  // porte le jeton d'authentification — une navigation directe partirait sans.
  const downloadTestFile = async () => {
    try {
      const res = await api.get(`/bank-transfer/templates/${id}/test-file?month=${month}`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ESSAI_${current?.bank ?? 'banque'}_${month}`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setMessage({ kind: 'error', text: t('bankFormats.testFileError', 'Fichier d\'essai indisponible — vérifiez qu\'il existe des virements pour cette période.') })
    }
  }

  if (!working || !current) return <Loader2 className="mt-4 h-5 w-5 animate-spin text-muted-foreground" />

  const update = (patch: Partial<Spec>) => setSpec({ ...working, ...patch })
  const setColumn = (i: number, seg: Segment) => update({ columns: working.columns.map((c, j) => (j === i ? seg : c)) })
  const moveColumn = (i: number, delta: number) => {
    const next = [...working.columns]
    const target = i + delta
    if (target < 0 || target >= next.length) return
    ;[next[i], next[target]] = [next[target]!, next[i]!]
    update({ columns: next })
  }

  const unmapped = working.columns.filter(c => c.source === 'unmapped').length
  const isFixed = working.output === 'fixed'
  const bank = bankDraft ?? current.bank
  // Un profil rattaché à un nom de banque que personne ne porte ne servira
  // jamais : le fichier est résolu par le nom exact de la banque de la fiche
  // salarié. On l'annonce sans bloquer — un format peut se préparer avant que
  // les fiches soient renseignées.
  const bankUnknown = employeeBanks.length > 0 && !employeeBanks.includes(bank.trim())
  // État « modifié » : il couvre le mapping ET le nom de la banque. Gardé sur le
  // seul mapping, une correction de banque restait non enregistrable — et pire,
  // l'activation restait ouverte, ce qui aurait activé l'ANCIENNE banque.
  const bankDirty = bank.trim() !== current.bank
  const dirty = Boolean(spec) || bankDirty
  const canSave = dirty && bank.trim().length > 0

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-border bg-muted/20 p-4">
      {current.status === 'draft' && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t('bankFormats.draftBanner', 'Brouillon — non utilisé pour les envois tant qu\'il n\'est pas activé.')}
        </div>
      )}
      {readOnly && (
        <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t('bankFormats.archivedBanner', 'Version archivée, conservée pour retrouver le format des fichiers déjà transmis.')}
        </div>
      )}

      {/* Banque de rattachement : c'est elle qui décide à quels salariés le format s'applique. */}
      <div>
        <label className="text-sm font-medium mb-1 block">{t('bankFormats.bank', 'Banque')}</label>
        <input list="known-banks" value={bank} maxLength={100}
          disabled={readOnly || current.status === 'active'}
          onChange={e => setBankDraft(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-border bg-background px-3 py-2 text-sm disabled:opacity-60" />
        <datalist id="known-banks">{knownBanks.map(b => <option key={b} value={b} />)}</datalist>
        {current.status === 'active' ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('bankFormats.bankLockedActive', 'Un format actif reste attaché à sa banque — le nom ne se corrige que sur un brouillon.')}
          </p>
        ) : bankUnknown && (
          <p className="mt-1 text-xs text-amber-700">
            {t('bankFormats.bankUnknown', 'Aucun salarié payé par virement n’a cette banque — le format ne s’appliquera à personne. Banques connues : {{list}}', { list: employeeBanks.join(', ') })}
          </p>
        )}
      </div>

      {/* Enveloppe */}
      <div className="grid gap-3 md:grid-cols-5">
        <Field label={t('bankFormats.output', 'Format')}>
          <select disabled={readOnly} value={working.output} onChange={e => update({ output: e.target.value as Spec['output'] })} className={selectCls}>
            {referential.outputs.map(o => <option key={o} value={o}>{t(`bankFormats.outputs.${o}`, o)}</option>)}
          </select>
        </Field>
        <Field label={t('bankFormats.encoding', 'Encodage')}>
          <select disabled={readOnly} value={working.encoding} onChange={e => update({ encoding: e.target.value as Spec['encoding'] })} className={selectCls}>
            {referential.encodings.map(o => <option key={o} value={o}>{o === 'latin1' ? 'ISO-8859-1' : 'UTF-8'}</option>)}
          </select>
        </Field>
        {working.output === 'csv' && (
          <Field label={t('bankFormats.delimiter', 'Séparateur')}>
            <select disabled={readOnly} value={working.delimiter} onChange={e => update({ delimiter: e.target.value })} className={selectCls}>
              {referential.delimiters.map(d => <option key={d} value={d}>{d === '\t' ? 'Tabulation' : d}</option>)}
            </select>
          </Field>
        )}
        <Field label={t('bankFormats.header', 'En-tête')}>
          <select disabled={readOnly} value={working.header.mode}
            onChange={e => update({ header: { ...working.header, mode: e.target.value as Spec['header']['mode'] } })} className={selectCls}>
            <option value="none">{t('bankFormats.headerNone', 'Aucun')}</option>
            <option value="labels">{t('bankFormats.headerLabels', 'Intitulés des colonnes')}</option>
            <option value="custom">{t('bankFormats.headerCustom', 'Ligne personnalisée')}</option>
          </select>
        </Field>
        <Field label={t('bankFormats.filename', 'Nom du fichier')}>
          <input disabled={readOnly} value={working.filename} maxLength={160}
            onChange={e => update({ filename: e.target.value })} className={selectCls} />
        </Field>
      </div>

      {/* Colonnes */}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-xs">
          <thead className="bg-muted/60 text-muted-foreground">
            <tr>
              <th className="p-2 text-left">{t('bankFormats.colLabel', 'Colonne du fichier banque')}</th>
              <th className="p-2 text-left">{t('bankFormats.colSource', 'Donnée NexusRH')}</th>
              <th className="p-2 text-left">{t('bankFormats.colTransform', 'Transformation')}</th>
              {isFixed && <th className="p-2 text-left">{t('bankFormats.colWidth', 'Largeur')}</th>}
              <th className="p-2 text-left">{t('bankFormats.colOptions', 'Options')}</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {working.columns.map((col, i) => (
              <tr key={i} className={col.source === 'unmapped' ? 'bg-amber-50/60' : undefined}>
                <td className="p-2">
                  <input disabled={readOnly} value={col.label ?? ''} maxLength={120}
                    onChange={e => setColumn(i, { ...col, label: e.target.value })} className={cellCls} />
                </td>
                <td className="p-2">
                  <select disabled={readOnly} value={col.source} onChange={e => setColumn(i, { ...col, source: e.target.value })}
                    className={`${cellCls} ${col.source === 'unmapped' ? 'border-amber-400' : ''}`}>
                    <option value="unmapped">— {t('bankFormats.toMap', 'à mapper')} —</option>
                    {Object.entries(
                      referential.sources.reduce<Record<string, typeof referential.sources>>((acc, s) => {
                        (acc[s.group] ??= []).push(s); return acc
                      }, {}),
                    ).map(([group, items]) => (
                      <optgroup key={group} label={GROUP_LABEL[group] ?? group}>
                        {items.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  {col.source === 'literal' && (
                    <input disabled={readOnly} value={col.literal ?? ''} maxLength={200}
                      placeholder="SALAIRE {mois}" onChange={e => setColumn(i, { ...col, literal: e.target.value })}
                      className={`${cellCls} mt-1`} />
                  )}
                  {col.source === 'blank' && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('bankFormats.blankHint', 'Colonne présente dans le fichier mais vide — à compléter à la main après l’export.')}
                    </p>
                  )}
                </td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-1">
                    {referential.transforms.map(tr => {
                      const on = col.transform?.includes(tr) ?? false
                      return (
                        <button key={tr} type="button" disabled={readOnly}
                          onClick={() => setColumn(i, {
                            ...col,
                            transform: on ? (col.transform ?? []).filter(x => x !== tr) : [...(col.transform ?? []), tr],
                          })}
                          className={`rounded px-1.5 py-0.5 text-[10px] border ${on ? 'bg-primary text-primary-foreground border-primary' : 'border-input text-muted-foreground'}`}>
                          {t(`bankFormats.transforms.${tr}`, tr)}
                        </button>
                      )
                    })}
                  </div>
                </td>
                {isFixed && (
                  <td className="p-2">
                    <div className="flex gap-1">
                      <input disabled={readOnly} type="number" min={1} max={4000} value={col.pad?.width ?? ''}
                        onChange={e => setColumn(i, { ...col, pad: { width: Number(e.target.value) || 1, align: col.pad?.align ?? 'left', char: col.pad?.char ?? ' ' } })}
                        className={`${cellCls} w-16`} />
                      <select disabled={readOnly} value={col.pad?.align ?? 'left'}
                        onChange={e => setColumn(i, { ...col, pad: { width: col.pad?.width ?? 1, align: e.target.value as 'left' | 'right', char: col.pad?.char ?? ' ' } })}
                        className={`${cellCls} w-20`}>
                        <option value="left">{t('bankFormats.alignLeft', 'gauche')}</option>
                        <option value="right">{t('bankFormats.alignRight', 'droite')}</option>
                      </select>
                      <select disabled={readOnly} value={col.pad?.char ?? ' '}
                        onChange={e => setColumn(i, { ...col, pad: { width: col.pad?.width ?? 1, align: col.pad?.align ?? 'left', char: e.target.value } })}
                        className={`${cellCls} w-16`}>
                        <option value=" ">{t('bankFormats.padSpace', 'espace')}</option>
                        <option value="0">0</option>
                      </select>
                    </div>
                  </td>
                )}
                <td className="p-2">
                  <div className="flex flex-wrap items-center gap-1">
                    <input disabled={readOnly} type="number" min={1} max={4000} value={col.truncate ?? ''}
                      placeholder={t('bankFormats.truncate', 'tronquer')}
                      onChange={e => setColumn(i, { ...col, truncate: e.target.value ? Number(e.target.value) : undefined })}
                      className={`${cellCls} w-24`} />
                    {col.source === 'computed.value_date' && (
                      <select disabled={readOnly} value={col.dateFormat ?? ''} onChange={e => setColumn(i, { ...col, dateFormat: e.target.value || undefined })} className={`${cellCls} w-28`}>
                        <option value="">{t('bankFormats.dateRaw', 'AAAA-MM-JJ')}</option>
                        {referential.dateFormats.map(f => <option key={f} value={f}>{f}</option>)}
                      </select>
                    )}
                    {(col.source === 'payslip.net_payable' || col.source === 'payslip.gross_salary' || col.source === 'computed.total_amount') && (
                      <select disabled={readOnly} value={String(col.amountScale ?? 1)}
                        onChange={e => setColumn(i, { ...col, amountScale: Number(e.target.value) })} className={`${cellCls} w-28`}>
                        <option value="1">{t('bankFormats.scaleUnit', 'FCFA entier')}</option>
                        <option value="100">{t('bankFormats.scaleCents', '×100 (centimes)')}</option>
                      </select>
                    )}
                  </div>
                </td>
                <td className="p-2">
                  <div className="flex gap-1">
                    <button type="button" disabled={readOnly} onClick={() => moveColumn(i, -1)} className="rounded p-1 hover:bg-muted"><ArrowUp className="h-3 w-3" /></button>
                    <button type="button" disabled={readOnly} onClick={() => moveColumn(i, 1)} className="rounded p-1 hover:bg-muted"><ArrowDown className="h-3 w-3" /></button>
                    <button type="button" disabled={readOnly} onClick={() => update({ columns: working.columns.filter((_, j) => j !== i) })} className="rounded p-1 text-destructive hover:bg-muted"><Trash2 className="h-3 w-3" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!readOnly && (
        <button type="button" onClick={() => update({ columns: [...working.columns, { label: '', source: 'unmapped' }] })}
          className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-1.5 text-xs hover:bg-muted">
          <Plus className="h-3 w-3" /> {t('bankFormats.addColumn', 'Ajouter une colonne')}
        </button>
      )}

      {unmapped > 0 && (
        <p className="flex items-center gap-2 text-xs text-amber-700">
          <AlertCircle className="h-4 w-4" />
          {t('bankFormats.unmappedWarning', '{{n}} colonne(s) restent à mapper — l\'activation est bloquée tant qu\'elles ne le sont pas.', { n: unmapped })}
        </p>
      )}

      {/* Aperçu + activation */}
      <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
        <div>
          <label className="text-xs font-medium mb-1 block">{t('bankFormats.previewMonth', 'Aperçu sur la paie')}</label>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} className={selectCls} />
        </div>
        <button type="button" disabled={!month || previewMut.isPending} onClick={() => previewMut.mutate()}
          className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm hover:bg-muted disabled:opacity-50">
          {previewMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
          {t('bankFormats.preview', 'Aperçu')}
        </button>
        {month && (
          <button type="button" onClick={() => void downloadTestFile()}
            className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm hover:bg-muted">
            <Download className="h-4 w-4" /> {t('bankFormats.testFile', 'Fichier d\'essai')}
          </button>
        )}
        {!readOnly && (
          <>
            <button type="button" disabled={saveMut.isPending || !canSave} onClick={() => saveMut.mutate()}
              className="rounded-lg border border-input px-3 py-2 text-sm hover:bg-muted disabled:opacity-50">
              {t('bankFormats.save', 'Enregistrer le brouillon')}
            </button>
            <button type="button" disabled={activateMut.isPending || current.status === 'active' || unmapped > 0 || dirty}
              onClick={() => activateMut.mutate()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {activateMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {t('bankFormats.activate', 'Activer ce format')}
            </button>
          </>
        )}
      </div>

      {spec && (
        <p className="text-xs text-muted-foreground">
          {t('bankFormats.unsaved', 'Modifications non enregistrées — enregistrez avant d\'activer.')}
        </p>
      )}

      {message && (
        <p className={`flex items-center gap-2 text-sm ${message.kind === 'ok' ? 'text-emerald-700' : 'text-destructive'}`}>
          {message.kind === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />} {message.text}
        </p>
      )}

      {preview && (
        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">
            {t('bankFormats.previewInfo', '{{file}} · {{rows}} virement(s) au total, {{shown}} affiché(s) · {{total}}', {
              file: preview.filename, rows: preview.rowCount, shown: preview.previewRows, total: formatFCFA(preview.totalAmount),
            })}
          </p>
          {preview.lines
            ? <pre className="max-h-64 overflow-auto rounded bg-muted/60 p-3 font-mono text-[11px] leading-relaxed whitespace-pre">{preview.lines.join('\n')}</pre>
            : (
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-[11px]">
                  <tbody>
                    {preview.table.map((line, i) => (
                      <tr key={i} className={i === 0 ? 'font-semibold' : undefined}>
                        {line.map((cell, j) => <td key={j} className="border border-border px-2 py-1">{cell}</td>)}
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

const selectCls = 'rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-full'
const cellCls = 'rounded border border-input bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring w-full'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium mb-1 block text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}
