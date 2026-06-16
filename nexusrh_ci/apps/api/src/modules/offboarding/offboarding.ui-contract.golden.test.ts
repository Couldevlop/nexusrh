/**
 * GOLDEN — Contrat UI ↔ API du module Processus de sortie (offboarding).
 *
 * Invariants : clé module alignée API↔web, mapping + enregistrement, sidebar +
 * route protégées, i18n FR/EN, endpoints consommés par la page (dont le calcul
 * du solde), table provisionnée + migrée lazy.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { MODULE_KEYS } from '../../services/tenant-modules.service.js'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WEB_SRC = join(API_SRC, '..', '..', '..', 'apps', 'web', 'src')
const readApi = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')
const readWeb = (...p: string[]) => readFileSync(join(WEB_SRC, ...p), 'utf8')

const modulesService = readApi('services', 'tenant-modules.service.ts')
const appTs          = readApi('app.ts')
const routes         = readApi('modules', 'offboarding', 'offboarding.routes.ts')
const migrations     = readApi('utils', 'schema-migrations.ts')
const provisioning   = readApi('db', 'provisioning.ts')
const webModules     = readWeb('lib', 'modules.ts')
const sidebar        = readWeb('components', 'layout', 'Sidebar.tsx')
const appTsx         = readWeb('App.tsx')
const page           = readWeb('pages', 'offboarding', 'OffboardingPage.tsx')
const i18nIndex      = readWeb('i18n', 'index.ts')

describe('GOLDEN offboarding — clé de module alignée API ↔ web', () => {
  it("'offboarding' clé canonique API + web (actif par défaut)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('offboarding')).toBe(true)
    expect(webModules).toContain(`'offboarding'`)
    expect(webModules).toMatch(/offboarding:\s+true/)
  })
  it('mapping URL + enregistrement route', () => {
    expect(modulesService).toContain(`['/offboarding',      'offboarding']`)
    expect(appTs).toContain('offboardingRoutes')
    expect(appTs).toMatch(/register\(offboardingRoutes,\s*\{\s*prefix:\s*'\/offboarding'\s*\}\)/)
  })
})

describe('GOLDEN offboarding — sidebar & route protégées', () => {
  it('entrée sidebar gatée rôle + module', () => {
    expect(sidebar).toContain(`to: '/offboarding'`)
    expect(sidebar).toContain(`labelKey: 'offboarding'`)
    expect(sidebar).toContain(`moduleKey: 'offboarding'`)
  })
  it('route protégée par RoleGuard + ModuleGuard offboarding', () => {
    expect(appTsx).toContain('OffboardingPage')
    expect(appTsx).toMatch(/path="offboarding"[\s\S]{0,240}moduleKey="offboarding"/)
  })
})

describe('GOLDEN offboarding — endpoints consommés', () => {
  it('liste + création + checklist + solde de tout compte', () => {
    expect(page).toContain(`api.get('/offboarding')`)
    expect(page).toContain(`api.post('/offboarding'`)
    expect(page).toContain('/offboarding/')
    expect(page).toContain('/settlement')
    expect(routes).toContain(`fastify.post('/:id/settlement'`)
    expect(routes).toContain('computeSettlement')
  })
})

describe('GOLDEN offboarding — i18n FR/EN', () => {
  it('namespace enregistré + labels nav, sans BOM', () => {
    expect(i18nIndex).toMatch(/offboarding/)
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'offboarding.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      expect(JSON.parse(readWeb('i18n', 'locales', lang, 'nav.json'))['offboarding']).toBeDefined()
    }
  })
})

describe('GOLDEN offboarding — table provisionnée + migrée lazy', () => {
  it('offboarding_cases dans provisioning ET migration lazy', () => {
    expect(provisioning).toContain('offboarding_cases')
    expect(migrations).toContain('offboarding_cases')
  })
})
