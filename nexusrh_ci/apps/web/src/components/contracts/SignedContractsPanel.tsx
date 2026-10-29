/**
 * Contrat de travail signé — panneau RH (fiche employé, détail du contrat).
 *
 * - RH (admin, hr_manager, hr_officer) : liste + téléchargement + dépôt.
 * - readonly : liste + téléchargement.
 * - manager : dépôt + liste des versions déposées (sans téléchargement), et
 *   uniquement si l'admin a activé l'option « dépôt par le manager » (l'API
 *   vérifie en plus que l'employé est dans son périmètre).
 */
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Download, FileSignature, Loader2, Upload, PenLine } from 'lucide-react'
import { api, formatDate } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { isModuleEnabled } from '@/lib/modules'
import {
  SIGNED_CONTRACT_MAX_BYTES, apiErrorMessage, downloadPdf, useSignedContractOptions,
  type SignedContractItem,
} from '@/lib/signed-contracts'

const HR_UPLOAD_ROLES = ['admin', 'hr_manager', 'hr_officer']
const HR_READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'readonly']

interface ContractOption { id: string; type: string; start_date: string; status: string }

function canSeeSignedContractsPanel(role: string, managerUploadEnabled: boolean): boolean {
  return HR_READ_ROLES.includes(role) || (role === 'manager' && managerUploadEnabled)
}

export function SignedContractsPanel({ employeeId, contractId }: {
  employeeId: string
  /** Contrat imposé (détail d'un contrat) : pas de sélecteur. */
  contractId?: string
}) {
  const { t } = useTranslation('contracts')
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role ?? '')
  const tenantConfig = useAuthStore((s) => s.tenantConfig)
  const { data: options } = useSignedContractOptions()
  const isManager = role === 'manager'
  const canUpload = HR_UPLOAD_ROLES.includes(role) || (isManager && options?.managerContractUpload === true)
  const canDownload = HR_READ_ROLES.includes(role)
  // Rattaché au module « contracts » (désactivable par le super_admin).
  const visible = isModuleEnabled(tenantConfig, 'contracts')
    && canSeeSignedContractsPanel(role, options?.managerContractUpload === true)

  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [selectedContract, setSelectedContract] = useState(contractId ?? '')
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const listKey = ['contracts', 'signed', 'employee', employeeId]
  const listQ = useQuery({
    queryKey: listKey,
    enabled: visible,
    retry: false,
    queryFn: async () => (await api.get(`/contracts/signed/employee/${employeeId}`)).data.data as SignedContractItem[],
  })
  // Sélecteur de contrat : RH uniquement (le manager n'a pas accès aux contrats OHADA).
  const contractsQ = useQuery({
    queryKey: ['contracts', 'employee', employeeId],
    enabled: visible && !contractId && HR_READ_ROLES.includes(role),
    retry: false,
    queryFn: async () => (await api.get(`/contracts/employee/${employeeId}`)).data.data as ContractOption[],
  })

  const uploadMut = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('no-file')
      const form = new FormData()
      form.append('file', file)
      const params = new URLSearchParams()
      if (selectedContract) params.set('contractId', selectedContract)
      if (title.trim()) params.set('title', title.trim())
      const qs = params.toString()
      const res = await api.post(`/contracts/signed/employee/${employeeId}${qs ? `?${qs}` : ''}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return res.data.data as { version: number }
    },
    onSuccess: (d) => {
      setMessage({ kind: 'ok', text: t('signed.uploaded', { version: d.version }) })
      setFile(null)
      setTitle('')
      if (fileRef.current) fileRef.current.value = ''
      void qc.invalidateQueries({ queryKey: listKey })
      void qc.invalidateQueries({ queryKey: ['contracts'] })
    },
    onError: (err) => setMessage({ kind: 'error', text: apiErrorMessage(err, t('signed.uploadError')) }),
  })

  if (!visible) return null

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMessage(null)
    const f = e.target.files?.[0] ?? null
    if (f && f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
      setMessage({ kind: 'error', text: t('signed.pdfOnly') })
      e.target.value = ''
      setFile(null)
      return
    }
    if (f && f.size > SIGNED_CONTRACT_MAX_BYTES) {
      setMessage({ kind: 'error', text: t('signed.tooLarge') })
      e.target.value = ''
      setFile(null)
      return
    }
    setFile(f)
  }

  const onDownload = async (item: SignedContractItem) => {
    if (!item.fileDocumentId) return
    try {
      await downloadPdf(`/contracts/signed/documents/${item.fileDocumentId}/file?download=1`, item.fileName ?? 'contrat.pdf')
    } catch (err) {
      setMessage({ kind: 'error', text: apiErrorMessage(err, t('signed.loadError')) })
    }
  }

  const items = (listQ.data ?? []).filter((i) => !contractId || i.contractId === contractId || i.source === 'signature')

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <FileSignature className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">{t('signed.title')}</h2>
      </div>

      {canUpload && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t('signed.hint')}{' '}
            {options?.employeeContractAccess ? t('signed.employeeAccessOn') : t('signed.employeeAccessOff')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`signed-file-${employeeId}`} className="text-xs font-medium text-muted-foreground">{t('signed.file')}</label>
              <input id={`signed-file-${employeeId}`} ref={fileRef} type="file" accept="application/pdf,.pdf" onChange={onPick}
                className="mt-1 block w-full text-sm" />
            </div>
            <div>
              <label htmlFor={`signed-title-${employeeId}`} className="text-xs font-medium text-muted-foreground">{t('signed.docTitle')}</label>
              <input id={`signed-title-${employeeId}`} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm" />
            </div>
            {!contractId && (contractsQ.data?.length ?? 0) > 0 && (
              <div className="sm:col-span-2">
                <label htmlFor={`signed-contract-${employeeId}`} className="text-xs font-medium text-muted-foreground">{t('signed.contract')}</label>
                <select id={`signed-contract-${employeeId}`} value={selectedContract} onChange={(e) => setSelectedContract(e.target.value)}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm">
                  <option value="">{t('signed.noContract')}</option>
                  {(contractsQ.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {t(`types.${c.type}`, { defaultValue: c.type.toUpperCase() })} — {formatDate(c.start_date)} ({t(`statuses.${c.status}`, { defaultValue: c.status })})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <button type="button" onClick={() => uploadMut.mutate()} disabled={!file || uploadMut.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {uploadMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploadMut.isPending ? t('signed.uploading') : t('signed.upload')}
          </button>
        </div>
      )}

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'}
          className={cn('text-sm', message.kind === 'ok' ? 'text-green-700' : 'text-destructive')}>
          {message.text}
        </p>
      )}

      {listQ.isError && <p className="text-sm text-destructive">{apiErrorMessage(listQ.error, t('signed.loadError'))}</p>}
      {listQ.isSuccess && items.length === 0 && <p className="text-sm text-muted-foreground">{t('signed.empty')}</p>}
      {items.length > 0 && (
        <ul className="divide-y divide-border text-sm">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{item.title ?? item.fileName ?? t('signed.title')}</p>
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  {item.version != null && <span>{t('signed.version', { version: item.version })}</span>}
                  <span className={cn('rounded-full px-1.5 py-0.5', item.isCurrent ? 'bg-green-100 text-green-700' : 'bg-muted')}>
                    {item.isCurrent ? t('signed.current') : t('signed.archived')}
                  </span>
                  {item.source === 'upload' && item.createdAt && <span>{t('signed.depositedOn', { date: formatDate(item.createdAt) })}</span>}
                  {item.signedElectronicallyAt && (
                    <span className="inline-flex items-center gap-1 text-emerald-700">
                      <PenLine className="h-3 w-3" />{t('signed.signedElectronically', { date: formatDate(item.signedElectronicallyAt) })}
                    </span>
                  )}
                  {!item.fileDocumentId && <span>{t('signed.noFile')}</span>}
                </p>
              </div>
              {canDownload && item.fileDocumentId && (
                <button type="button" onClick={() => void onDownload(item)}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1 text-xs hover:bg-accent">
                  <Download className="h-3.5 w-3.5" /> {t('signed.download')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
