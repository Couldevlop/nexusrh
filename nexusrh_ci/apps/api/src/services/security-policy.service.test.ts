import { describe, it, expect } from 'vitest'
import bcrypt from 'bcryptjs'
import {
  DEFAULT_SECURITY_POLICY,
  mapSecurityPolicyRow,
  getSecurityPolicy,
  isPasswordExpired,
  daysUntilPasswordExpiry,
  effectiveTenantMfaRequired,
  isPasswordReused,
  toLockoutPolicy,
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
      lockout_enabled: false,
      lockout_max_attempts: 7,
      lockout_window_minutes: 30,
      lockout_duration_minutes: 60,
    })).toEqual({
      mfaRequiredSuperAdmin: true,
      mfaRequiredTenantUsers: false,
      passwordMaxAgeDays: 60,
      passwordHistoryCount: 10,
      breachCheckEnabled: false,
      lockoutEnabled: false,
      lockoutMaxAttempts: 7,
      lockoutWindowMinutes: 30,
      lockoutDurationMinutes: 60,
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

describe('toLockoutPolicy — minutes → secondes (OWASP A07)', () => {
  it('convertit les minutes en secondes', () => {
    expect(toLockoutPolicy({ ...DEFAULT_SECURITY_POLICY, lockoutEnabled: true,
      lockoutMaxAttempts: 5, lockoutWindowMinutes: 15, lockoutDurationMinutes: 30 }))
      .toEqual({ enabled: true, maxAttempts: 5, windowSeconds: 900, lockSeconds: 1800 })
  })
  it('fenêtre/durée nulles → repli 15 min (évite un TTL nul côté Redis)', () => {
    const p = toLockoutPolicy({ ...DEFAULT_SECURITY_POLICY,
      lockoutWindowMinutes: 0, lockoutDurationMinutes: 0 })
    expect(p.windowSeconds).toBe(900)
    expect(p.lockSeconds).toBe(900)
  })
  it('propage enabled=false', () => {
    expect(toLockoutPolicy({ ...DEFAULT_SECURITY_POLICY, lockoutEnabled: false }).enabled).toBe(false)
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

// ─────────────────────────────────────────────────────────────────────────────
// Compte à rebours avant expiration (paliers J-7 / J-2 / J-1)
// ─────────────────────────────────────────────────────────────────────────────
describe("daysUntilPasswordExpiry — compte à rebours", () => {
  const now = new Date("2026-11-25T12:00:00Z")
  const ilYA = (jours: number) =>
    new Date(now.getTime() - jours * 24 * 60 * 60 * 1000).toISOString()

  it("ne dit rien quand l expiration est désactivée", () => {
    expect(daysUntilPasswordExpiry(ilYA(100), 0, now)).toBeNull()
    expect(daysUntilPasswordExpiry(ilYA(100), -1, now)).toBeNull()
  })

  it("ne dit rien sans password_changed_at (même grâce qu au login)", () => {
    expect(daysUntilPasswordExpiry(null, 30, now)).toBeNull()
    expect(daysUntilPasswordExpiry(undefined, 30, now)).toBeNull()
    expect(daysUntilPasswordExpiry("pas-une-date", 30, now)).toBeNull()
  })

  it("compte les jours restants sur une politique à 30 jours", () => {
    expect(daysUntilPasswordExpiry(ilYA(0), 30, now)).toBe(30)
    expect(daysUntilPasswordExpiry(ilYA(23), 30, now)).toBe(7)
    expect(daysUntilPasswordExpiry(ilYA(28), 30, now)).toBe(2)
    expect(daysUntilPasswordExpiry(ilYA(29), 30, now)).toBe(1)
  })

  it("renvoie 0, et jamais un négatif, quand c est déjà expiré", () => {
    expect(daysUntilPasswordExpiry(ilYA(31), 30, now)).toBe(0)
    expect(daysUntilPasswordExpiry(ilYA(120), 30, now)).toBe(0)
  })

  it("pile à l échéance, le login laisse encore passer : 1 jour, pas 0", () => {
    // isPasswordExpired utilise « > » : à exactement 30 jours le compte n est
    // pas expiré. Annoncer 0 ici casserait l équivalence avec le login.
    expect(isPasswordExpired(ilYA(30), 30, now)).toBe(false)
    expect(daysUntilPasswordExpiry(ilYA(30), 30, now)).toBe(1)
  })

  it("arrondit au plafond : à 23 h de l échéance il reste 1 jour, pas 0", () => {
    const changeA = new Date(now.getTime() - (30 * 24 - 23) * 60 * 60 * 1000)
    expect(daysUntilPasswordExpiry(changeA, 30, now)).toBe(1)
  })

  it("s accorde toujours avec isPasswordExpired", () => {
    for (const jours of [0, 1, 15, 23, 28, 29, 29.9, 30, 31, 400]) {
      const changeA = new Date(now.getTime() - jours * 24 * 60 * 60 * 1000).toISOString()
      const expire = isPasswordExpired(changeA, 30, now)
      const reste = daysUntilPasswordExpiry(changeA, 30, now)
      // Les deux fonctions doivent dire la même chose : zéro jour restant
      // équivaut à expiré. Un désaccord annoncerait une échéance que le login
      // ne fait pas respecter, ou l inverse.
      expect(reste === 0).toBe(expire)
    }
  })
})
