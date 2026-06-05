/**
 * GOLDEN — Préservation des mots de passe au re-seed.
 *
 * Contexte : le déploiement rejoue le seed (DROP SCHEMA ... CASCADE) à chaque
 * push → sans cette protection, tous les mots de passe revenaient à la valeur
 * de démo (compromise dans HIBP) et l'utilisateur devait re-changer son mot de
 * passe après CHAQUE déploiement.
 *
 * Couvre :
 *   - capture : lecture des credentials par schéma, repli pré-migration
 *     (colonne password_changed_at absente), schéma inexistant toléré ;
 *   - restauration : UPDATE avec le hash préservé + COALESCE des dates ;
 *   - CÂBLAGE seed.ts (scan source) : capture AVANT le DROP, restauration
 *     appelée, super_admin en DO NOTHING, agency_users sans reset de hash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { Pool } from 'pg'
import {
  captureExistingCredentials,
  restorePreservedCredentials,
} from './seed-credentials.js'

const queryMock = vi.fn()
const pool = { query: queryMock } as unknown as Pool

beforeEach(() => { queryMock.mockReset() })

describe('captureExistingCredentials', () => {
  it('capture hash + dates pour chaque utilisateur de chaque schéma', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [
        { email: 'admin@sotra.ci', password_hash: 'HASH_ADMIN', password_changed_at: '2026-06-01', last_login_at: '2026-06-03' },
        { email: 'employe@sotra.ci', password_hash: 'HASH_EMP', password_changed_at: '2026-05-20', last_login_at: null },
      ] })
      .mockResolvedValueOnce({ rows: [
        { email: 'admin@cab.ci', password_hash: 'HASH_CAB', password_changed_at: '2026-06-02', last_login_at: '2026-06-02' },
      ] })
    const map = await captureExistingCredentials(pool, ['tenant_sotra', 'tenant_cab'])
    expect(map.size).toBe(3)
    expect(map.get('tenant_sotra|admin@sotra.ci')?.password_hash).toBe('HASH_ADMIN')
    expect(map.get('tenant_cab|admin@cab.ci')?.password_changed_at).toBe('2026-06-02')
  })

  it('repli pré-migration : colonne password_changed_at absente → 2e requête sans elle', async () => {
    queryMock
      .mockRejectedValueOnce(new Error('column "password_changed_at" does not exist'))
      .mockResolvedValueOnce({ rows: [
        { email: 'a@b.ci', password_hash: 'H', last_login_at: '2026-01-01' },
      ] })
    const map = await captureExistingCredentials(pool, ['tenant_old'])
    expect(map.get('tenant_old|a@b.ci')).toEqual({
      email: 'a@b.ci', password_hash: 'H', last_login_at: '2026-01-01', password_changed_at: null,
    })
  })

  it('premier seed (schéma inexistant) → map vide, aucune erreur', async () => {
    queryMock.mockRejectedValue(new Error('schema does not exist'))
    const map = await captureExistingCredentials(pool, ['tenant_ghost'])
    expect(map.size).toBe(0)
  })
})

describe('restorePreservedCredentials', () => {
  it('restaure le hash préservé (le mot de passe changé survit au re-seed)', async () => {
    queryMock.mockResolvedValue({ rowCount: 1 })
    const map = new Map([
      ['tenant_sotra|admin@sotra.ci', {
        password_hash: 'HASH_CHANGE_PAR_UTILISATEUR',
        password_changed_at: '2026-06-01', last_login_at: '2026-06-03',
      }],
    ])
    const restored = await restorePreservedCredentials(pool, map)
    expect(restored).toBe(1)
    const call = queryMock.mock.calls[0]!
    expect(String(call[0])).toContain('"tenant_sotra".users')
    expect(String(call[0])).toContain('password_hash = $1')
    // COALESCE : ne PAS écraser les valeurs par du NULL
    expect(String(call[0])).toContain('COALESCE($2::timestamptz, password_changed_at)')
    expect(call[1]).toEqual(['HASH_CHANGE_PAR_UTILISATEUR', '2026-06-01', '2026-06-03', 'admin@sotra.ci'])
  })

  it('un email contenant des caractères spéciaux reste intact (clé schema|email)', async () => {
    queryMock.mockResolvedValue({ rowCount: 1 })
    const map = new Map([
      ['tenant_x|jean.kouadio+rh@sotra.ci', { password_hash: 'H', password_changed_at: null, last_login_at: null }],
    ])
    await restorePreservedCredentials(pool, map)
    expect(queryMock.mock.calls[0]![1]![3]).toBe('jean.kouadio+rh@sotra.ci')
  })

  it('erreur sur un schéma → les autres restaurations continuent', async () => {
    queryMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ rowCount: 1 })
    const map = new Map([
      ['tenant_a|a@a.ci', { password_hash: 'H1', password_changed_at: null, last_login_at: null }],
      ['tenant_b|b@b.ci', { password_hash: 'H2', password_changed_at: null, last_login_at: null }],
    ])
    const restored = await restorePreservedCredentials(pool, map)
    expect(restored).toBe(1)
  })
})

// ─── Câblage dans seed.ts (scan source — seed.ts exécute main() à l'import) ──
describe('seed.ts — câblage de la préservation', () => {
  const seedSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'seed.ts'), 'utf8')

  it('capture les credentials AVANT le DROP des schémas', () => {
    const captureIdx = seedSrc.indexOf('captureExistingCredentials(pool')
    const dropIdx = seedSrc.indexOf('DROP SCHEMA IF EXISTS')
    expect(captureIdx).toBeGreaterThan(-1)
    expect(dropIdx).toBeGreaterThan(-1)
    expect(captureIdx).toBeLessThan(dropIdx)
  })

  it('restaure les credentials après recréation des tenants', () => {
    expect(seedSrc).toContain('restorePreservedCredentials(pool, preservedCredentials)')
  })

  it('super_admin : ON CONFLICT DO NOTHING (mot de passe changé non écrasé)', () => {
    const superAdminBlock = seedSrc.slice(
      seedSrc.indexOf('INSERT INTO platform.platform_users'),
      seedSrc.indexOf('Super admin créé'),
    )
    expect(superAdminBlock).toContain('ON CONFLICT (email) DO NOTHING')
    expect(superAdminBlock).not.toContain('DO UPDATE SET password_hash')
  })

  it('agency_users : pas de reset du password_hash au re-seed', () => {
    const agencyBlock = seedSrc.slice(
      seedSrc.indexOf('INSERT INTO platform.agency_users'),
      seedSrc.indexOf('Cabinet Talents CI créé'),
    )
    expect(agencyBlock).toContain('ON CONFLICT (email) DO UPDATE SET is_active = true')
    expect(agencyBlock).not.toContain('DO UPDATE SET password_hash')
  })
})
