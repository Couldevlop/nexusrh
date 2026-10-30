/**
 * Contrat de travail signé — client partagé (espace employé, fiche RH,
 * détail du contrat). La vérité des droits est côté API ; ces helpers ne font
 * que masquer ce que l'utilisateur ne peut pas utiliser.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

export interface SignedContractOptions {
  employeeContractAccess: boolean
  managerContractUpload: boolean
}

export interface SignedContractItem {
  id: string
  source: 'upload' | 'signature'
  title: string | null
  contractId: string | null
  contractType: string | null
  contractStartDate: string | null
  fileName: string | null
  sizeBytes: number | null
  version: number | null
  isCurrent: boolean
  createdAt: string | null
  signedElectronicallyAt: string | null
  fileDocumentId: string | null
}

export const SIGNED_CONTRACT_MAX_BYTES = 10 * 1024 * 1024

const DISABLED: SignedContractOptions = { employeeContractAccess: false, managerContractUpload: false }

/** Options tenant du contrat signé. Erreur (module désactivé, réseau…) → tout désactivé. */
export function useSignedContractOptions(enabled = true) {
  return useQuery<SignedContractOptions>({
    queryKey: ['contracts', 'signed', 'settings'],
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      try {
        const r = await api.get('/contracts/signed/settings')
        return (r.data?.data as SignedContractOptions | undefined) ?? DISABLED
      } catch {
        return DISABLED
      }
    },
  })
}

/** Récupère un PDF authentifié et renvoie une URL blob: locale (à révoquer). */
export async function fetchPdfObjectUrl(path: string): Promise<string> {
  const res = await api.get(path, { responseType: 'blob' })
  return URL.createObjectURL(new Blob([res.data as Blob], { type: 'application/pdf' }))
}

/** Téléchargement d'un PDF authentifié sous un nom donné. */
export async function downloadPdf(path: string, fileName: string): Promise<void> {
  const url = await fetchPdfObjectUrl(path)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: string } } } | undefined)?.response?.data
  if (data?.error) return data.error
  return fallback
}
