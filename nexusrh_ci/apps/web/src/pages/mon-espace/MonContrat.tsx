import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { FileSignature, Eye, Download, X, PenLine } from 'lucide-react'
import { api, formatDate } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  apiErrorMessage, downloadPdf, fetchPdfObjectUrl, type SignedContractItem,
} from '@/lib/signed-contracts'

const filePath = (docId: string) => `/contracts/signed/me/${docId}/file`

function itemTitle(item: SignedContractItem, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (item.title) return item.title
  if (item.contractType && item.contractStartDate) {
    return t('contract.contractLabel', { type: item.contractType.toUpperCase(), date: formatDate(item.contractStartDate) })
  }
  return t('contract.defaultTitle')
}

/** Aperçu PDF dans une modale (URL blob: — le document n'est jamais servi sans authentification). */
function PdfViewer({ docId, title, onClose }: { docId: string; title: string; onClose: () => void }) {
  const { t } = useTranslation('monEspace')
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    fetchPdfObjectUrl(filePath(docId))
      .then((u) => { objectUrl = u; if (!cancelled) setUrl(u) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [docId])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-4" role="dialog" aria-modal="true">
      <div className="flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <p className="truncate text-sm font-semibold">{title}</p>
          <button type="button" onClick={onClose} aria-label={t('contract.close')}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 bg-muted/30">
          {error && <p className="p-8 text-center text-sm text-destructive">{t('contract.viewError')}</p>}
          {!error && !url && <p className="p-8 text-center text-sm text-muted-foreground">{t('contract.loading')}</p>}
          {url && <iframe src={url} title={title} className="h-full w-full" />}
        </div>
      </div>
    </div>
  )
}

export default function MonContrat() {
  const { t } = useTranslation('monEspace')
  const [viewing, setViewing] = useState<{ docId: string; title: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const listQ = useQuery({
    queryKey: ['contracts', 'signed', 'me'],
    retry: false,
    queryFn: async () => (await api.get('/contracts/signed/me')).data.data as SignedContractItem[],
  })

  const disabled = (listQ.error as { response?: { status?: number; data?: { featureDisabled?: boolean } } } | null)
    ?.response?.data?.featureDisabled === true
  const items = listQ.data ?? []
  const current = items.filter((i) => i.isCurrent)
  const history = items.filter((i) => !i.isCurrent)

  const onDownload = async (item: SignedContractItem) => {
    if (!item.fileDocumentId) return
    setActionError(null)
    try {
      await downloadPdf(`${filePath(item.fileDocumentId)}?download=1`, item.fileName ?? 'contrat.pdf')
    } catch (err) {
      setActionError(apiErrorMessage(err, t('contract.viewError')))
    }
  }

  const renderItem = (item: SignedContractItem, muted: boolean) => {
    const title = itemTitle(item, t)
    return (
      <div key={item.id} className={cn('rounded-xl border border-border bg-card p-4', muted && 'opacity-75')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">{title}</p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {item.version != null && <span>{t('contract.version', { version: item.version })}</span>}
              {item.source === 'upload' && item.createdAt && <span>{t('contract.depositedOn', { date: formatDate(item.createdAt) })}</span>}
              {item.signedElectronicallyAt && (
                <span className="inline-flex items-center gap-1 text-emerald-700">
                  <PenLine className="h-3 w-3" />
                  {t('contract.signedElectronically', { date: formatDate(item.signedElectronicallyAt) })}
                </span>
              )}
            </div>
            {!item.fileDocumentId && <p className="mt-2 text-xs text-muted-foreground">{t('contract.noFile')}</p>}
          </div>
          {item.fileDocumentId && (
            <div className="flex shrink-0 gap-2">
              <button type="button" onClick={() => setViewing({ docId: item.fileDocumentId!, title })}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent">
                <Eye className="h-3.5 w-3.5" /> {t('contract.view')}
              </button>
              <button type="button" onClick={() => void onDownload(item)}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
                <Download className="h-3.5 w-3.5" /> {t('contract.download')}
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><FileSignature className="h-5 w-5" /></div>
        <div>
          <h1 className="text-xl font-bold">{t('contract.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('contract.subtitle')}</p>
        </div>
      </div>

      {actionError && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</p>}

      {listQ.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('contract.loading')}</p>}
      {listQ.isError && (
        <p className={cn('rounded-xl border border-border bg-card py-12 text-center text-sm', disabled ? 'text-muted-foreground' : 'text-destructive')}>
          {disabled ? t('contract.disabled') : apiErrorMessage(listQ.error, t('contract.loadError'))}
        </p>
      )}
      {listQ.isSuccess && items.length === 0 && (
        <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('contract.empty')}</p>
      )}

      {current.length > 0 && (
        <section className="max-w-3xl space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('contract.current')}</h2>
          {current.map((i) => renderItem(i, false))}
        </section>
      )}
      {history.length > 0 && (
        <section className="max-w-3xl space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('contract.history')}</h2>
          {history.map((i) => renderItem(i, true))}
        </section>
      )}

      {viewing && <PdfViewer docId={viewing.docId} title={viewing.title} onClose={() => setViewing(null)} />}
    </div>
  )
}
