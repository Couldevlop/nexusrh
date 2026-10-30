/**
 * Propositions de contrat versées au dossier salarié (fiche employé, RH).
 *
 * Distinctes du CONTRAT SIGNÉ (SignedContractsPanel) : une proposition est le
 * document généré au recrutement, non signé, qui peut différer du contrat
 * finalement signé. Jamais visible par l'employé (/mon-espace ne liste que
 * la catégorie signed_contract). Masqué s'il n'y a aucune proposition.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Download, FileText } from 'lucide-react'
import { api, formatDate } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { apiErrorMessage, downloadPdf } from '@/lib/signed-contracts'

const READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'readonly']

interface ProposalDocument {
  id: string
  title: string | null
  fileName: string
  sizeBytes: number
  version: number
  isCurrent: boolean
  createdAt: string
}

export function ContractProposalsPanel({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation('contracts')
  const role = useAuthStore((s) => s.user?.role ?? '')
  const visible = READ_ROLES.includes(role)
  const [error, setError] = useState<string | null>(null)

  const listQ = useQuery({
    queryKey: ['contracts', 'proposals', 'employee', employeeId],
    enabled: visible,
    retry: false,
    queryFn: async () =>
      (await api.get(`/recruitment/contract-proposals/employee/${employeeId}`)).data.data as ProposalDocument[],
  })

  const items = listQ.data ?? []
  if (!visible || items.length === 0) return null

  const onDownload = async (doc: ProposalDocument) => {
    setError(null)
    try {
      await downloadPdf(`/recruitment/contract-proposals/documents/${doc.id}/file?download=1`, doc.fileName || 'proposition.pdf')
    } catch (err) {
      setError(apiErrorMessage(err, t('proposal.loadError')))
    }
  }

  return (
    <div className="rounded-xl border border-dashed border-amber-300 bg-card p-5 space-y-3">
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <FileText className="h-4 w-4 text-amber-600" />
        <h2 className="font-semibold">{t('proposal.title')}</h2>
      </div>
      <p className="text-xs text-muted-foreground">{t('proposal.hint')}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <ul className="divide-y divide-border text-sm">
        {items.map((doc) => (
          <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className="truncate font-medium">{doc.title ?? doc.fileName}</p>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>{t('proposal.version', { version: doc.version })}</span>
                <span className={cn('rounded-full px-1.5 py-0.5', doc.isCurrent ? 'bg-amber-100 text-amber-800' : 'bg-muted')}>
                  {doc.isCurrent ? t('proposal.current') : t('proposal.archived')}
                </span>
                <span>{t('proposal.generatedOn', { date: formatDate(doc.createdAt) })}</span>
              </p>
            </div>
            <button type="button" onClick={() => void onDownload(doc)}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1 text-xs hover:bg-accent">
              <Download className="h-3.5 w-3.5" /> {t('proposal.download')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
