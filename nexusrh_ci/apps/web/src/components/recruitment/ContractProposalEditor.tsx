/**
 * Proposition de contrat — éditeur RH (recrutement).
 *
 * La proposition générée n'est PAS le contrat signé : la RH adapte les
 * articles (texte Markdown simple : « # » titre, « ## » article), chaque
 * enregistrement crée une nouvelle version (historique téléchargeable) et le
 * PDF est re-rendu aux couleurs/mentions légales de l'employeur. L'aperçu est
 * servi en URL blob: (l'API répond X-Frame-Options: DENY).
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Download, FileSignature, Loader2, RefreshCw, Save, Wand2, X } from 'lucide-react'
import { api, formatDate } from '@/lib/api'
import { cn } from '@/lib/utils'

export const PROPOSAL_MARKDOWN_MAX = 100_000

export interface ContractProposalVersion {
  id: string
  version: number
  isCurrent: boolean
  createdAt: string
  contractType: string
  sizeBytes: number
}

export interface ContractProposalState {
  enabled: boolean
  current: { id: string; version: number; markdown: string; contractType: string; createdAt: string } | null
  versions: ContractProposalVersion[]
}

export const contractProposalKey = (applicationId: string) => ['recruitment', 'contract-proposal', applicationId]

function errorText(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: string } } } | undefined)?.response?.data
  return data?.error ?? fallback
}

async function pdfBlobUrl(applicationId: string, version?: number): Promise<string> {
  const res = await api.get(
    `/recruitment/applications/${applicationId}/contract-proposal/pdf${version ? `?version=${version}` : ''}`,
    { responseType: 'blob' },
  )
  return URL.createObjectURL(new Blob([res.data as Blob], { type: 'application/pdf' }))
}

export function ContractProposalEditor({ applicationId, candidate, onClose, onRegenerate }: {
  applicationId: string
  candidate: string
  onClose: () => void
  /** Rouvre le formulaire de génération (nouvelle version depuis le modèle). */
  onRegenerate: () => void
}) {
  const { t } = useTranslation('recruitment')
  const qc = useQueryClient()
  const [markdown, setMarkdown] = useState('')
  const [dirty, setDirty] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const urlRef = useRef<string | null>(null)

  const stateQ = useQuery({
    queryKey: contractProposalKey(applicationId),
    retry: false,
    queryFn: async () =>
      (await api.get(`/recruitment/applications/${applicationId}/contract-proposal`)).data.data as ContractProposalState,
  })
  const current = stateQ.data?.current ?? null

  const replacePreview = (url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = url
    setPreviewUrl(url)
  }

  const refreshPreview = async () => {
    setPreviewBusy(true)
    try {
      replacePreview(await pdfBlobUrl(applicationId))
    } catch {
      replacePreview(null)
      setMessage({ kind: 'error', text: t('contract.previewUnavailable') })
    } finally {
      setPreviewBusy(false)
    }
  }

  // Texte et aperçu suivent la version courante (chargement, nouvelle version).
  useEffect(() => {
    if (!current) return
    setMarkdown(current.markdown)
    setDirty(false)
    void refreshPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  const saveMut = useMutation({
    mutationFn: async () =>
      (await api.put(`/recruitment/applications/${applicationId}/contract-proposal`, { markdown })).data.data as { version: number },
    onSuccess: (d) => {
      setMessage({ kind: 'ok', text: t('contract.saved', { version: d.version }) })
      void qc.invalidateQueries({ queryKey: contractProposalKey(applicationId) })
    },
    onError: (err) => setMessage({ kind: 'error', text: errorText(err, t('contract.saveError')) }),
  })

  const download = async (version?: number) => {
    try {
      const url = await pdfBlobUrl(applicationId, version)
      const a = document.createElement('a')
      a.href = url
      a.download = `proposition_contrat${version ? `_v${version}` : ''}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, t('contract.loadError')) })
    }
  }

  const tooLong = markdown.length > PROPOSAL_MARKDOWN_MAX
  const canSave = !!current && dirty && markdown.trim().length > 0 && !tooLong && !saveMut.isPending

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
         role="dialog" aria-modal="true" aria-labelledby="contract-proposal-title">
      <div className="flex h-[92vh] w-full max-w-6xl flex-col rounded-xl bg-card shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div>
            <div className="flex items-center gap-2">
              <FileSignature className="h-5 w-5 text-primary" />
              <h3 id="contract-proposal-title" className="text-lg font-semibold">{t('contract.proposalTitle')}</h3>
              {current && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{t('contract.version', { version: current.version })}</span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{candidate}</p>
            <p className="mt-1 text-xs text-amber-700">{t('contract.proposalSubtitle')}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t('contract.close')}
            className="rounded-md p-1 hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        {stateQ.isLoading && (
          <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
        )}
        {stateQ.isError && (
          <p role="alert" className="p-4 text-sm text-destructive">{errorText(stateQ.error, t('contract.loadError'))}</p>
        )}
        {stateQ.isSuccess && !current && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
            <p>{t('contract.noProposal')}</p>
            <button type="button" onClick={onRegenerate}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
              <Wand2 className="h-4 w-4" /> {t('contract.generateProposal')}
            </button>
          </div>
        )}

        {current && (
          <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-2">
            <div className="flex min-h-0 flex-col gap-2">
              <label htmlFor="contract-proposal-md" className="text-xs font-medium text-muted-foreground">
                {t('contract.editorLabel')}
              </label>
              <textarea id="contract-proposal-md" value={markdown} spellCheck
                onChange={(e) => { setMarkdown(e.target.value); setDirty(true); setMessage(null) }}
                className="min-h-[240px] flex-1 resize-none rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed" />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className={cn(tooLong ? 'text-destructive' : 'text-muted-foreground')}>
                  {markdown.length.toLocaleString('fr-FR')} / {PROPOSAL_MARKDOWN_MAX.toLocaleString('fr-FR')}
                  {dirty && <span className="ml-2 text-amber-700">{t('contract.unsaved')}</span>}
                </span>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={onRegenerate}
                    className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 hover:bg-muted">
                    <Wand2 className="h-3.5 w-3.5" /> {t('contract.regenerate')}
                  </button>
                  <button type="button" onClick={() => saveMut.mutate()} disabled={!canSave}
                    className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                    {saveMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    {saveMut.isPending ? t('contract.saving') : t('contract.save')}
                  </button>
                </div>
              </div>
              {message && (
                <p role={message.kind === 'error' ? 'alert' : 'status'}
                  className={cn('text-sm', message.kind === 'ok' ? 'text-green-700' : 'text-destructive')}>
                  {message.text}
                </p>
              )}
            </div>

            <div className="flex min-h-0 flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{t('contract.preview')}</span>
                <div className="flex gap-2 text-xs">
                  <button type="button" onClick={() => void refreshPreview()} disabled={previewBusy}
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50">
                    <RefreshCw className={cn('h-3.5 w-3.5', previewBusy && 'animate-spin')} /> {t('contract.refreshPreview')}
                  </button>
                  <button type="button" onClick={() => void download()}
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted">
                    <Download className="h-3.5 w-3.5" /> {t('contract.downloadCurrent')}
                  </button>
                </div>
              </div>
              <div className="min-h-[240px] flex-1 overflow-hidden rounded-md border border-border bg-muted/30">
                {previewUrl
                  ? <iframe src={previewUrl} title={t('contract.preview')} className="h-full w-full" />
                  : <p className="p-4 text-xs text-muted-foreground">{previewBusy ? '…' : t('contract.previewUnavailable')}</p>}
              </div>
              <div className="max-h-36 overflow-y-auto rounded-md border border-border">
                <p className="border-b border-border px-3 py-1.5 text-xs font-medium">{t('contract.versions')}</p>
                <ul className="divide-y divide-border text-xs">
                  {(stateQ.data?.versions ?? []).map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span>
                        {t('contract.version', { version: v.version })} · {formatDate(v.createdAt)}
                        {v.isCurrent && <span className="ml-2 rounded-full bg-green-100 px-1.5 py-0.5 text-green-700">{t('contract.current')}</span>}
                      </span>
                      <button type="button" onClick={() => void download(v.version)}
                        className="inline-flex items-center gap-1 rounded border px-2 py-0.5 hover:bg-muted">
                        <Download className="h-3 w-3" /> {t('contract.download')}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
