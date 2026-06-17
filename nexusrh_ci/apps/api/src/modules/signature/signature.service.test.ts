import { describe, it, expect } from 'vitest'
import {
  REQUEST_STATUSES, isValidRequestStatus, isValidDocumentType,
  canSend, canCancel, canDelete, deriveStatus, nextSignatoryOrder, canSignatorySign, progress,
  type Signatory,
} from './signature.service.js'

const sig = (status: Signatory['status'], orderIndex = 0): Signatory => ({ status, orderIndex })

describe('signature.service — validations', () => {
  it('statuts & types de documents bornés', () => {
    expect(REQUEST_STATUSES).toContain('signed')
    expect(isValidRequestStatus('pending')).toBe(true)
    expect(isValidRequestStatus('hacked')).toBe(false)
    expect(isValidDocumentType('contract')).toBe(true)
    expect(isValidDocumentType('virus')).toBe(false)
  })
})

describe('signature.service — transitions', () => {
  it('envoi : brouillon avec ≥1 signataire seulement', () => {
    expect(canSend('draft', 1)).toBe(true)
    expect(canSend('draft', 0)).toBe(false)
    expect(canSend('pending', 2)).toBe(false)
  })
  it('annulation : brouillon ou en cours ; suppression : brouillon seul', () => {
    expect(canCancel('draft')).toBe(true)
    expect(canCancel('pending')).toBe(true)
    expect(canCancel('signed')).toBe(false)
    expect(canDelete('draft')).toBe(true)
    expect(canDelete('pending')).toBe(false)
  })
})

describe('signature.service — dérivation de statut', () => {
  it('un refus prime sur tout', () => {
    expect(deriveStatus([sig('signed'), sig('declined'), sig('pending')])).toBe('declined')
  })
  it('tous signés → signed', () => {
    expect(deriveStatus([sig('signed'), sig('signed')])).toBe('signed')
  })
  it('échéance dépassée et personne n\'a refusé → expired', () => {
    expect(deriveStatus([sig('pending'), sig('signed')], { expired: true })).toBe('expired')
  })
  it('en cours par défaut', () => {
    expect(deriveStatus([sig('pending'), sig('signed')])).toBe('pending')
  })
  it('liste vide → pending (jamais "signed" par vacuité)', () => {
    expect(deriveStatus([])).toBe('pending')
  })
})

describe('signature.service — ordre & droit de signer', () => {
  const list = [sig('signed', 0), sig('pending', 1), sig('pending', 2)]
  it('séquentiel : prochain = plus petit ordre en attente', () => {
    expect(nextSignatoryOrder(list, true)).toBe(1)
    expect(nextSignatoryOrder([sig('signed', 0), sig('signed', 1)], true)).toBeNull()
  })
  it('parallèle : aucune contrainte d\'ordre (null)', () => {
    expect(nextSignatoryOrder(list, false)).toBeNull()
  })
  it('séquentiel : seul le signataire dont c\'est le tour peut signer', () => {
    expect(canSignatorySign('pending', list[1], list, true)).toBe(true)
    expect(canSignatorySign('pending', list[2], list, true)).toBe(false) // pas son tour
  })
  it('parallèle : tout signataire en attente peut signer', () => {
    expect(canSignatorySign('pending', list[2], list, false)).toBe(true)
  })
  it('refuse si demande non active, signataire déjà signé, ou inconnu', () => {
    expect(canSignatorySign('draft', list[1], list, true)).toBe(false)
    expect(canSignatorySign('pending', list[0], list, true)).toBe(false) // déjà signé
    expect(canSignatorySign('pending', undefined, list, true)).toBe(false)
  })
})

describe('signature.service — progression', () => {
  it('compte signés/refusés et pourcentage', () => {
    expect(progress([sig('signed'), sig('signed'), sig('pending'), sig('declined')]))
      .toEqual({ signed: 2, declined: 1, total: 4, pct: 50 })
    expect(progress([])).toEqual({ signed: 0, declined: 0, total: 0, pct: 0 })
  })
})
