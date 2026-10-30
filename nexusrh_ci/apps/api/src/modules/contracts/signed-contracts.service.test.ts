import { describe, it, expect, vi } from 'vitest'
import type { Pool } from 'pg'
import {
  checkSignedContractPdf, loadSignedContractOptions, mergeSignedContracts, safePdfFileName,
  SIGNED_CONTRACT_MAX_BYTES, type SignedDocumentRow,
} from './signed-contracts.service.js'

const PDF = Buffer.from('%PDF-1.4\n%%EOF')

describe('checkSignedContractPdf (OWASP A03/A08)', () => {
  it('accepte un vrai PDF', () => {
    expect(checkSignedContractPdf(PDF, 'application/pdf', 'contrat.PDF')).toEqual({ ok: true })
  })
  it('rejette un MIME autre que PDF', () => {
    expect(checkSignedContractPdf(PDF, 'application/msword', 'contrat.pdf')).toEqual({ ok: false, reason: 'mime' })
  })
  it('rejette une extension autre que .pdf', () => {
    expect(checkSignedContractPdf(PDF, 'application/pdf', 'contrat.exe')).toEqual({ ok: false, reason: 'extension' })
  })
  it('rejette un fichier vide', () => {
    expect(checkSignedContractPdf(Buffer.alloc(0), 'application/pdf', 'c.pdf')).toEqual({ ok: false, reason: 'empty' })
  })
  it('rejette un fichier trop volumineux', () => {
    const big = Buffer.concat([PDF, Buffer.alloc(SIGNED_CONTRACT_MAX_BYTES)])
    expect(checkSignedContractPdf(big, 'application/pdf', 'c.pdf')).toEqual({ ok: false, reason: 'too_large' })
  })
  it('rejette un contenu dont les octets magiques ne sont pas « %PDF- »', () => {
    expect(checkSignedContractPdf(Buffer.from('<html>pdf</html>'), 'application/pdf', 'c.pdf')).toEqual({ ok: false, reason: 'signature' })
  })
})

describe('safePdfFileName', () => {
  it('neutralise les caractères dangereux pour Content-Disposition', () => {
    expect(safePdfFileName('../../etc/"passwd".pdf')).not.toMatch(/["/\\]/)
  })
  it('ajoute .pdf et propose un nom par défaut', () => {
    expect(safePdfFileName('contrat')).toBe('contrat.pdf')
    expect(safePdfFileName('')).toBe('contrat-signe.pdf')
  })
})

describe('loadSignedContractOptions', () => {
  it('lit les deux options du tenant', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ employee_contract_access: true, manager_contract_upload: false }] }) } as unknown as Pool
    await expect(loadSignedContractOptions(pool, 'tenant_x')).resolves.toEqual({ employeeContractAccess: true, managerContractUpload: false })
  })
  it('fail-closed : erreur DB → tout désactivé', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('column does not exist')) } as unknown as Pool
    await expect(loadSignedContractOptions(pool, 'tenant_x')).resolves.toEqual({ employeeContractAccess: false, managerContractUpload: false })
  })
  it('tenant introuvable → tout désactivé', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool
    await expect(loadSignedContractOptions(pool, 'tenant_x')).resolves.toEqual({ employeeContractAccess: false, managerContractUpload: false })
  })
})

describe('mergeSignedContracts', () => {
  const doc = (over: Partial<SignedDocumentRow>): SignedDocumentRow => ({
    id: 'd1', contract_id: 'c1', title: null, file_name: 'c.pdf', size_bytes: 10, version: 1, is_current: true,
    created_at: '2026-01-01', contract_type: 'cdi', contract_start_date: '2026-01-01', ...over,
  })
  it('une signature visant le document l\'annote au lieu d\'être dupliquée', () => {
    const out = mergeSignedContracts([doc({})], [{ id: 's1', title: 'CDI', document_type: 'contract', document_id: 'd1', completed_at: '2026-02-01' }])
    expect(out).toHaveLength(1)
    expect(out[0]?.signedElectronicallyAt).toBe('2026-02-01')
  })
  it('une signature visant le contrat annote la version COURANTE de ce contrat', () => {
    const out = mergeSignedContracts(
      [doc({ id: 'old', version: 1, is_current: false }), doc({ id: 'new', version: 2 })],
      [{ id: 's1', title: 'CDI', document_type: 'contract', document_id: 'c1', completed_at: '2026-02-01' }],
    )
    expect(out.find((i) => i.id === 'new')?.signedElectronicallyAt).toBe('2026-02-01')
    expect(out.find((i) => i.id === 'old')?.signedElectronicallyAt).toBeNull()
  })
  it('une signature sans document déposé apparaît seule, sans fichier', () => {
    const out = mergeSignedContracts([], [{ id: 's1', title: 'Avenant', document_type: 'amendment', document_id: null, completed_at: '2026-02-01' }])
    expect(out).toEqual([expect.objectContaining({ id: 's1', source: 'signature', fileDocumentId: null })])
  })
})
