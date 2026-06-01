import { describe, it, expect } from 'vitest'
import bcrypt from 'bcryptjs'
import {
  DEFAULT_SECURITY_POLICY,
  mapSecurityPolicyRow,
  getSecurityPolicy,
  isPasswordExpired,
  effectiveTenantMfaRequired,
  isPasswordReused,
} from './security-policy.service.js'

describe('mapSecurityPolicyRow — robustesse types/colonnes (OWASP A07)', () => {
  it('row null → défauts', () => {
    expect(mapSecurityPolicyRow(null)).toEqual(DEFAULT_SECURITY_POLICY)
  })
  it('row undefined → défauts', () => {
    expect(mapSecurityPolicyRow(undefined)).toEqual(DEFAULT_SECURITY_POLICY)
  })
  it('row vide (colonnes absentes) → défauts (table non encore migrée)', () => {
    expect(mapSecurityPolicyRow({})).toEqual(DEFAULT_SECURITY_POLICY)
  })
  it('booleans natifs + ints natifs', () => {
    expect(mapSecurityPolicyRow({
      mfa_required_super_admin: true,
      mfa_required_tenant_users: false,
      password_max_age_days: 60,
      password_history_count: 10,
      breach_check_enabled: false,
    })).toEqual({
      mfaRequiredSuperAdmin: true,
      mfaRequiredTenantUsers: false,
      passwordMaxAgeDays: 60,
      passwordHistoryCount: 10,
      breachCheckEnabled: false,
    })
  })
  it('coercition string/number (driver renvoie parfois t/f/string)', () => {
    const p = mapSecurityPolicyRow({
      mfa_required_super_admin: 'true',
      mfa_required_tenant_users: 't',
      password_max_age_days: '45',
      password_history_count: '0',
      breach_check_enabled: '1',
    })
    expect(p.mfaRequiredSuperAdmin).toBe(true)
    expect(p.mfaRequiredTenantUsers).toBe(true)
    expect(p.passwordMaxAgeDays).toBe(45)
    expect(p.passwordHistoryCount).toBe(0)
    expect(p.breachCheckEnabled).toBe(true)
  })
  it('booléen numérique non nul → true ; entier de type inattendu → défaut', () => {
    const p = mapSecurityPolicyRow({
      mfa_required_super_admin: 1,            // number ≠ 0 → true
      password_max_age_days: true,            // type inattendu (ni number ni string) → défaut
    })
    expect(p.mfaRequiredSuperAdmin).toBe(true)
    expect(p.passwordMaxAgeDays).toBe(30)
  })
  it('valeurs invalides (négatif / NaN / type inattendu) → défauts par champ', () => {
    const p = mapSecurityPolicyRow({
      mfa_required_super_admin: 0,
      mfa_required_tenant_users: {},
      password_max_age_days: -5,
      password_history_count: 'abc',
      breach_check_enabled: 'false',
    })
    expect(p.mfaRequiredSuperAdmin).toBe(false)        // number 0 → false
    expect(p.mfaRequiredTenantUsers).toBe(false)       // type inattendu → défaut (false)
    expect(p.passwordMaxAgeDays).toBe(30)              // négatif → défaut
    expect(p.passwordHistoryCount).toBe(5)             // NaN → défaut
    expect(p.breachCheckEnabled).toBe(false)           // 'false' → false
  })
})

describe('getSecurityPolicy — lecture BD non bloquante (OWASP A10)', () => {
  it('ligne présente → mappée', async () => {
    const pool = { query: async () => ({ rows: [{ mfa_required_super_admin: true }] }) }
    const p = await getSecurityPolicy(pool as never)
    expect(p.mfaRequiredSuperAdmin).toBe(true)
  })
  it('aucune ligne → défauts', async () => {
    const pool = { query: async () => ({ rows: [] }) }
    expect(await getSecurityPolicy(pool as never)).toEqual(DEFAULT_SECURITY_POLICY)
  })
  it('erreur BD (table absente) → défauts, jamais d\'exception', async () => {
    const pool = { query: async () => { throw new Error('relation "platform.platform_settings" does not exist') } }
    expect(await getSecurityPolicy(pool as never)).toEqual(DEFAULT_SECURITY_POLICY)
  })
})

describe('isPasswordExpired — durée de vie (OWASP A07)', () => {
  const now = new Date('2026-06-01T00:00:00Z')
  it('maxAgeDays = 0 → jamais expiré (désactivé)', () => {
    expect(isPasswordExpired('2000-01-01', 0, now)).toBe(false)
  })
  it('changedAt absent → non expiré (grâce comptes hérités)', () => {
    expect(isPasswordExpired(null, 30, now)).toBe(false)
    expect(isPasswordExpired(undefined, 30, now)).toBe(false)
  })
  it('date invalide → non expiré', () => {
    expect(isPasswordExpired('pas-une-date', 30, now)).toBe(false)
  })
  it('mot de passe récent (< 30 j) → non expiré', () => {
    expect(isPasswordExpired('2026-05-20T00:00:00Z', 30, now)).toBe(false)
  })
  it('mot de passe ancien (> 30 j) → expiré', () => {
    expect(isPasswordExpired('2026-01-01T00:00:00Z', 30, now)).toBe(true)
  })
  it('accepte un objet Date', () => {
    expect(isPasswordExpired(new Date('2026-01-01T00:00:00Z'), 30, now)).toBe(true)
  })
  it('utilise new Date() par défaut si now non fourni', () => {
    // Un changement il y a ~10 ans est forcément expiré quel que soit "maintenant".
    expect(isPasswordExpired('2015-01-01T00:00:00Z', 30)).toBe(true)
  })
})

describe('effectiveTenantMfaRequired — durcissement only (OWASP A07)', () => {
  it('global true → true (quelle que soit la surcharge)', () => {
    expect(effectiveTenantMfaRequired({ mfaRequiredTenantUsers: true }, false)).toBe(true)
    expect(effectiveTenantMfaRequired({ mfaRequiredTenantUsers: true }, null)).toBe(true)
  })
  it('global false + surcharge true → true (le tenant durcit)', () => {
    expect(effectiveTenantMfaRequired({ mfaRequiredTenantUsers: false }, true)).toBe(true)
  })
  it('global false + surcharge false/absente → false', () => {
    expect(effectiveTenantMfaRequired({ mfaRequiredTenantUsers: false }, false)).toBe(false)
    expect(effectiveTenantMfaRequired({ mfaRequiredTenantUsers: false }, null)).toBe(false)
    expect(effectiveTenantMfaRequired({ mfaRequiredTenantUsers: false }, undefined)).toBe(false)
  })
})

describe('isPasswordReused — historique anti-réutilisation (OWASP A07)', () => {
  it('correspond à un ancien hash → true', async () => {
    const h = await bcrypt.hash('OldPass123', 4)
    expect(await isPasswordReused('OldPass123', [h])).toBe(true)
  })
  it('ne correspond à aucun → false', async () => {
    const h = await bcrypt.hash('OldPass123', 4)
    expect(await isPasswordReused('TotallyNew456', [h])).toBe(false)
  })
  it('historique vide → false', async () => {
    expect(await isPasswordReused('whatever', [])).toBe(false)
  })
  it('ignore les entrées nulles/vides', async () => {
    const h = await bcrypt.hash('Match9', 4)
    expect(await isPasswordReused('Match9', [null, undefined, '', h])).toBe(true)
  })
  it('hash corrompu (type invalide) → ignoré sans exception', async () => {
    expect(await isPasswordReused('x', [123 as unknown as string])).toBe(false)
  })
})
