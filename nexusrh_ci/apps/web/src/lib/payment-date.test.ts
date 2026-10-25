/**
 * Recette 10/2026 : dates affichées au format local (plus d'ISO brut
 * « 2026-10-31T00:00:00.000Z ») et modes de paiement lisibles.
 */
import { describe, it, expect, afterEach } from 'vitest'
import i18n from '@/i18n'
import { formatDate } from './api'
import { canonicalMmProvider, paymentMethodLabel } from './payment'

afterEach(async () => { await i18n.changeLanguage('fr') })

describe('formatDate', () => {
  it('date de départ sérialisée par PostgreSQL → 31/10/2026, sans glissement de jour', async () => {
    await i18n.changeLanguage('fr')
    expect(formatDate('2026-10-31T00:00:00.000Z')).toBe('31/10/2026')
    expect(formatDate('2026-10-31')).toBe('31/10/2026')
  })

  it('suit la langue de l’interface', async () => {
    await i18n.changeLanguage('en')
    expect(formatDate('2026-10-31T00:00:00.000Z')).toBe('31/10/2026')
    expect(formatDate('2026-01-05')).toBe('05/01/2026')
  })

  it('valeurs vides ou invalides : jamais d’exception', () => {
    expect(formatDate(null)).toBe('')
    expect(formatDate(undefined)).toBe('')
    expect(formatDate('pas une date')).toBe('pas une date')
  })
})

describe('modes de paiement', () => {
  it('canonicalMmProvider accepte les formes historiques', () => {
    expect(canonicalMmProvider('mtn_momo')).toBe('mtn')
    expect(canonicalMmProvider('orange_money')).toBe('orange')
    expect(canonicalMmProvider('wave')).toBe('wave')
    expect(canonicalMmProvider('cofina')).toBe('cofina')
    expect(canonicalMmProvider('inconnu')).toBe('')
    expect(canonicalMmProvider(null)).toBe('')
  })

  it('paymentMethodLabel traduit mode et opérateur (FR/EN)', async () => {
    await i18n.changeLanguage('fr')
    expect(paymentMethodLabel('bank_transfer')).toBe('Virement bancaire')
    expect(paymentMethodLabel('mobile_money')).toBe('Mobile Money')
    expect(paymentMethodLabel('mtn_momo')).toBe('MTN MoMo')
    expect(paymentMethodLabel('mtn')).toBe('MTN MoMo')
    expect(paymentMethodLabel('orange_money')).toBe('Orange Money')
    expect(paymentMethodLabel('cofina')).toBe('COFINA')
    await i18n.changeLanguage('en')
    expect(paymentMethodLabel('bank_transfer')).toBe('Bank transfer')
    expect(paymentMethodLabel('code_inconnu')).toBe('code_inconnu')
    expect(paymentMethodLabel(null)).toBe('')
  })
})
