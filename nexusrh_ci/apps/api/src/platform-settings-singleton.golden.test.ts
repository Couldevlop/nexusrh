/**
 * GOLDEN — platform.platform_settings est un SINGLETON.
 *
 * Cette table porte la politique de sécurité plateforme (MFA super_admin/tenant,
 * verrouillage de compte, durée de vie / historique des mots de passe), lue à
 * CHAQUE login par getSecurityPolicy(). Bug historique (corrigé) : les routes
 * faisaient `INSERT ... DEFAULT VALUES ON CONFLICT DO NOTHING` SANS contrainte
 * d'unicité → une nouvelle ligne à chaque PATCH, et `SELECT ... LIMIT 1` sans
 * `ORDER BY` lisait la politique sur une ligne au hasard → enforcement MFA non
 * déterministe.
 *
 * Ce golden verrouille les invariants qui garantissent l'unicité et la lecture
 * déterministe. Conforme OWASP A07 (fiabilité du contrôle d'authentification).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const API_SRC = dirname(fileURLToPath(import.meta.url)) // apps/api/src

const read = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')

const migrations = read('utils', 'schema-migrations.ts')
const platformRoutes = read('modules', 'platform', 'platform.routes.ts')
const securityPolicy = read('services', 'security-policy.service.ts')

describe('GOLDEN platform_settings singleton — migration', () => {
  it('ajoute la colonne marqueur singleton', () => {
    expect(migrations).toContain('ADD COLUMN IF NOT EXISTS singleton boolean NOT NULL DEFAULT true')
  })

  it('crée un index UNIQUE sur singleton (rend les inserts idempotents)', () => {
    expect(migrations).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS platform_settings_singleton_idx ON platform\.platform_settings\(singleton\)/,
    )
  })

  it('dédoublonne d\'éventuelles lignes héritées avant l\'index unique', () => {
    expect(migrations).toMatch(/DELETE FROM platform\.platform_settings WHERE id NOT IN/)
  })

  it('garantit la présence de l\'unique ligne via ON CONFLICT (singleton)', () => {
    expect(migrations).toMatch(
      /INSERT INTO platform\.platform_settings \(singleton\) VALUES \(true\) ON CONFLICT \(singleton\) DO NOTHING/,
    )
  })
})

describe('GOLDEN platform_settings singleton — routes platform', () => {
  it('PATCH insère de façon idempotente (ON CONFLICT singleton), jamais de doublon', () => {
    expect(platformRoutes).toContain('ON CONFLICT (singleton) DO NOTHING')
  })

  it('ne réintroduit pas l\'UPDATE non déterministe (LIMIT 1 sans ORDER BY)', () => {
    expect(platformRoutes).not.toContain(
      'WHERE id = (SELECT id FROM platform.platform_settings LIMIT 1)',
    )
    expect(platformRoutes).toContain(
      'WHERE id = (SELECT id FROM platform.platform_settings ORDER BY created_at ASC LIMIT 1)',
    )
  })

  it('lit les settings de façon déterministe (ORDER BY created_at)', () => {
    // Aucun SELECT bare `platform_settings LIMIT 1` (toujours ordonné).
    expect(platformRoutes).not.toMatch(/SELECT \* FROM platform\.platform_settings LIMIT 1/)
  })
})

describe('GOLDEN platform_settings singleton — getSecurityPolicy', () => {
  it('lit la politique sur la ligne la plus ancienne, jamais au hasard', () => {
    expect(securityPolicy).toContain(
      'SELECT * FROM platform.platform_settings ORDER BY created_at ASC LIMIT 1',
    )
    expect(securityPolicy).not.toContain('SELECT * FROM platform.platform_settings LIMIT 1')
  })
})
