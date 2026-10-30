import { describe, it, expect } from 'vitest'
import {
  contractProposalsTableStatements, contractProposalRecategorizeStatements, CONTRACT_PROPOSAL_DOCUMENT_TITLE,
} from './contract-proposals.js'

describe('contract_proposals — DDL et reprise', () => {
  it('table idempotente, versionnée, unicité (candidature, version)', () => {
    const sql = contractProposalsTableStatements('tenant_demo').join('\n')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "tenant_demo".contract_proposals')
    for (const col of ['application_id', 'employee_id', 'legal_entity_id', 'contract_type', 'offer_details   jsonb', 'markdown', 'version', 'is_current', 'pdf', 'created_by']) {
      expect(sql).toContain(col)
    }
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS')
  })

  it('re-catégorise l’ancien document généré et rend le statut courant au contrat signé', () => {
    const [recat, restore] = contractProposalRecategorizeStatements('tenant_demo')
    expect(recat).toContain(`SET category = 'contract_proposal', title = '${CONTRACT_PROPOSAL_DOCUMENT_TITLE}'`)
    expect(recat).toContain(`WHERE category = 'signed_contract'`)
    expect(recat).toContain(`title = 'Contrat de travail (généré au recrutement)'`)
    expect(restore).toContain('SET is_current = true, replaced_by = NULL')
    expect(restore).toContain('NOT EXISTS')
  })
})
