/**
 * GOLDEN — Modules activables/désactivables par tenant (super_admin).
 *
 * Exigence produit : le super_admin peut activer/désactiver des modules pour un
 * tenant, et en masse pour un ou plusieurs tenants d'un cabinet (certains
 * clients ne veulent pas tous les modules). La vue DG 360° est un module
 * OPT-IN (désactivée par défaut, activable uniquement par le super_admin).
 *
 * Invariants verrouillés :
 *  1. Service pur : défauts (tout actif sauf dg_view), résolution des
 *     surcharges jsonb, mapping URL → module.
 *  2. Migration platform : colonne enabled_modules jsonb (backward compatible).
 *  3. Routes platform : PUT /tenants/:id/modules + bulk, réservées super_admin,
 *     clés bornées (OWASP A03), auditées (OWASP A09), cache invalidé.
 *  4. Enforcement API (OWASP A01) : hook global app.ts → 403 moduleDisabled,
 *     exemptions plateforme/super_admin/webhooks.
 *  5. tenantConfig.enabledModules exposé au login, au /me et à l'activation
 *     d'une session cabinet (le frontend filtre la sidebar dessus).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  MODULE_KEYS,
  MODULE_DEFAULTS,
  resolveEnabledModules,
  moduleKeyForUrl,
  getModulesForSchema,
  invalidateModulesCache,
} from './tenant-modules.service.js'
import type { Pool } from 'pg'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..') // apps/api/src
const read = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')

const appTs          = read('app.ts')
const migrations     = read('utils', 'schema-migrations.ts')
const platformRoutes = read('modules', 'platform', 'platform.routes.ts')
const authRoutes     = read('modules', 'auth', 'auth.routes.ts')
const agencyRoutes   = read('modules', 'agency', 'agency.routes.ts')

describe('GOLDEN modules tenant — service (défauts et résolution)', () => {
  it('tous les modules sont actifs par défaut SAUF la vue DG 360° (opt-in)', () => {
    for (const key of MODULE_KEYS) {
      expect(MODULE_DEFAULTS[key]).toBe(key === 'dg_view' ? false : true)
    }
  })

  it('surcharges jsonb partielles : seules les clés fournies changent', () => {
    const resolved = resolveEnabledModules({ recruitment: false, dg_view: true })
    expect(resolved.recruitment).toBe(false)
    expect(resolved.dg_view).toBe(true)
    expect(resolved.payroll).toBe(true)
    expect(resolved.absences).toBe(true)
  })

  it("'{}' (tenants existants) = comportement actuel inchangé (zéro régression)", () => {
    expect(resolveEnabledModules({})).toEqual(MODULE_DEFAULTS)
    expect(resolveEnabledModules(null)).toEqual(MODULE_DEFAULTS)
    expect(resolveEnabledModules(undefined)).toEqual(MODULE_DEFAULTS)
  })

  it('clés inconnues / valeurs non booléennes ignorées (OWASP A03)', () => {
    const resolved = resolveEnabledModules({ hacked: true, payroll: 'yes', ai: false })
    expect((resolved as Record<string, unknown>)['hacked']).toBeUndefined()
    expect(resolved.payroll).toBe(true) // 'yes' n'est pas un booléen → défaut
    expect(resolved.ai).toBe(false)
  })

  it('mapping URL → module couvre tous les préfixes des modules métier', () => {
    expect(moduleKeyForUrl('/payroll/periods')).toBe('payroll')
    expect(moduleKeyForUrl('/payroll-workflow/init')).toBe('payroll')
    expect(moduleKeyForUrl('/absences')).toBe('absences')
    expect(moduleKeyForUrl('/expenses/my')).toBe('expenses')
    expect(moduleKeyForUrl('/recruitment/jobs')).toBe('recruitment')
    expect(moduleKeyForUrl('/onboarding/journeys')).toBe('onboarding')
    expect(moduleKeyForUrl('/training/catalog')).toBe('training')
    expect(moduleKeyForUrl('/careers')).toBe('careers')
    expect(moduleKeyForUrl('/cnps/declarations')).toBe('cnps')
    expect(moduleKeyForUrl('/mobile-money/campaigns')).toBe('mobile_money')
    expect(moduleKeyForUrl('/reporting/overview')).toBe('reporting')
    expect(moduleKeyForUrl('/integrations/webhooks')).toBe('integrations')
    expect(moduleKeyForUrl('/ai/chat')).toBe('ai')
    expect(moduleKeyForUrl('/org-chart/departments')).toBe('org_chart')
    expect(moduleKeyForUrl('/discipline')).toBe('discipline')
    expect(moduleKeyForUrl('/offboarding')).toBe('offboarding')
    expect(moduleKeyForUrl('/climate/surveys')).toBe('climate')
    expect(moduleKeyForUrl('/succession/plans')).toBe('succession')
    expect(moduleKeyForUrl('/competencies/catalog')).toBe('competencies')
    expect(moduleKeyForUrl('/calibration/sessions')).toBe('calibration')
    expect(moduleKeyForUrl('/mobility/requests')).toBe('mobility')
    expect(moduleKeyForUrl('/classification/levels')).toBe('classification')
    expect(moduleKeyForUrl('/signature/requests')).toBe('signature')
    expect(moduleKeyForUrl('/security/sso-config')).toBe('security')
    expect(moduleKeyForUrl('/dg/overview')).toBe('dg_view')
  })

  it('les routes hors modules ne sont JAMAIS bloquées (auth, employés, settings…)', () => {
    expect(moduleKeyForUrl('/auth/login')).toBeNull()
    expect(moduleKeyForUrl('/employees')).toBeNull()
    expect(moduleKeyForUrl('/settings/users')).toBeNull()
    expect(moduleKeyForUrl('/platform/tenants')).toBeNull()
    expect(moduleKeyForUrl('/agency/my-tenants')).toBeNull()
    expect(moduleKeyForUrl('/referentiels')).toBeNull()
    expect(moduleKeyForUrl('/health')).toBeNull()
  })

  it('pas de faux positif par préfixe partiel (/payrollX ≠ /payroll)', () => {
    expect(moduleKeyForUrl('/payrollX')).toBeNull()
    expect(moduleKeyForUrl('/aix')).toBeNull()
    expect(moduleKeyForUrl('/dgx')).toBeNull()
  })

  it('getModulesForSchema : fail-open (DB en erreur → défauts, jamais de blocage)', async () => {
    invalidateModulesCache()
    const failingPool = { query: () => Promise.reject(new Error('db down')) } as unknown as Pool
    const modules = await getModulesForSchema(failingPool, 'tenant_failopen')
    expect(modules).toEqual(MODULE_DEFAULTS)
  })

  it('getModulesForSchema : lit les surcharges et met en cache', async () => {
    invalidateModulesCache()
    let calls = 0
    const fakePool = {
      query: () => {
        calls++
        return Promise.resolve({ rows: [{ enabled_modules: { recruitment: false } }] })
      },
    } as unknown as Pool
    const m1 = await getModulesForSchema(fakePool, 'tenant_cached')
    const m2 = await getModulesForSchema(fakePool, 'tenant_cached')
    expect(m1.recruitment).toBe(false)
    expect(m2.recruitment).toBe(false)
    expect(calls).toBe(1) // 2e lecture servie par le cache
    invalidateModulesCache()
  })
})

describe('GOLDEN modules tenant — migration platform', () => {
  it('ajoute enabled_modules jsonb NOT NULL DEFAULT {} (backward compatible)', () => {
    expect(migrations).toContain(
      `ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS enabled_modules jsonb NOT NULL DEFAULT '{}'`,
    )
  })
})

describe('GOLDEN modules tenant — routes platform (super_admin uniquement)', () => {
  it('PUT /tenants/:id/modules existe et est réservé au super_admin', () => {
    expect(platformRoutes).toContain(`fastify.put('/tenants/:id/modules'`)
    const putBlock = platformRoutes.slice(platformRoutes.indexOf(`fastify.put('/tenants/:id/modules'`))
    expect(putBlock.slice(0, 400)).toContain(`fastify.authorize('super_admin')`)
  })

  it('bulk cabinet : POST /tenants/modules-bulk (agencyId → tenants rattachés non détachés)', () => {
    expect(platformRoutes).toContain(`fastify.post('/tenants/modules-bulk'`)
    expect(platformRoutes).toContain('FROM platform.agency_tenants')
    expect(platformRoutes).toMatch(/agency_id = \$1 AND detached_at IS NULL/)
  })

  it('merge jsonb (les modules non fournis ne sont pas modifiés)', () => {
    expect(platformRoutes).toMatch(
      /enabled_modules = COALESCE\(enabled_modules, '\{\}'::jsonb\) \|\| \$2::jsonb/,
    )
  })

  it('clés strictement bornées à MODULE_KEYS (OWASP A03)', () => {
    expect(platformRoutes).toContain('MODULE_KEYS as readonly string[]).includes(k)')
  })

  it('actions auditées (OWASP A09) + cache invalidé (propagation immédiate)', () => {
    expect(platformRoutes).toContain(`'tenant.modules_updated'`)
    expect(platformRoutes).toContain(`'tenant.modules_bulk_updated'`)
    expect(platformRoutes.match(/invalidateModulesCache\(\)/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('GOLDEN modules tenant — enforcement API (OWASP A01)', () => {
  it('hook global : module désactivé → 403 moduleDisabled (la vérité est côté API)', () => {
    expect(appTs).toContain('moduleKeyForUrl(url)')
    expect(appTs).toContain('getModulesForSchema(maintenancePool')
    expect(appTs).toContain('moduleDisabled: true')
    expect(appTs).toMatch(/status\(403\)[\s\S]{0,200}moduleDisabled/)
  })

  it('exemptions : contexte plateforme / super_admin / webhooks signés', () => {
    const hook = appTs.slice(appTs.indexOf('Modules activables par tenant'))
    expect(hook.slice(0, 1600)).toContain(`u.schemaName === 'platform' || u.role === 'super_admin'`)
    expect(hook.slice(0, 1600)).toContain(`/mobile-money/webhooks/`)
  })
})

describe('GOLDEN modules tenant — tenantConfig.enabledModules (frontend)', () => {
  it('exposé au login ET au /auth/me (sidebar filtrée dès la connexion)', () => {
    expect(authRoutes.match(/enabledModules:\s+resolveEnabledModules/g)?.length).toBeGreaterThanOrEqual(2)
    expect(authRoutes).toContain(`COALESCE(enabled_modules, '{}'::jsonb) AS enabled_modules`)
  })

  it('exposé à l\'activation d\'une session cabinet (tenant client scopé)', () => {
    expect(agencyRoutes).toContain('enabledModules: resolveEnabledModules(t.enabledModules)')
  })
})
