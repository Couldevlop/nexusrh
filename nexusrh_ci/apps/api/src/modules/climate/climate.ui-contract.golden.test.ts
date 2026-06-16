/**
 * GOLDEN — Contrat UI ↔ API du module Enquêtes climat social.
 *
 * Invariants : clé module alignée API↔web, mapping + enregistrement, sidebar +
 * route RH protégées, self-service employé (mon-espace/climat), i18n FR/EN,
 * endpoints consommés, ANONYMAT (résultats agrégés sans employee_id),
 * tables provisionnées + migrées lazy.
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
const routes         = readApi('modules', 'climate', 'climate.routes.ts')
const migrations     = readApi('utils', 'schema-migrations.ts')
const provisioning   = readApi('db', 'provisioning.ts')
const webModules     = readWeb('lib', 'modules.ts')
const sidebar        = readWeb('components', 'layout', 'Sidebar.tsx')
const employeeLayout = readWeb('components', 'layout', 'EmployeeLayout.tsx')
const appTsx         = readWeb('App.tsx')
const rhPage         = readWeb('pages', 'climate', 'ClimatePage.tsx')
const selfPage       = readWeb('pages', 'mon-espace', 'MonClimat.tsx')
const i18nIndex      = readWeb('i18n', 'index.ts')

describe('GOLDEN climate — clé de module alignée API ↔ web', () => {
  it("'climate' clé canonique API + web (actif par défaut)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('climate')).toBe(true)
    expect(webModules).toContain(`'climate'`)
    expect(webModules).toMatch(/climate:\s+true/)
  })
  it('mapping URL + enregistrement route', () => {
    expect(modulesService).toContain(`['/climate',          'climate']`)
    expect(appTs).toContain('climateRoutes')
    expect(appTs).toMatch(/register\(climateRoutes,\s*\{\s*prefix:\s*'\/climate'\s*\}\)/)
  })
})

describe('GOLDEN climate — sidebar RH + self-service employé', () => {
  it('entrée sidebar RH gatée rôle + module', () => {
    expect(sidebar).toContain(`to: '/climate'`)
    expect(sidebar).toContain(`labelKey: 'climate'`)
    expect(sidebar).toContain(`moduleKey: 'climate'`)
  })
  it('route RH protégée par RoleGuard + ModuleGuard climate', () => {
    expect(appTsx).toContain('ClimatePage')
    expect(appTsx).toMatch(/path="climate"[\s\S]{0,220}moduleKey="climate"/)
  })
  it('self-service employé : nav + route mon-espace/climat', () => {
    expect(employeeLayout).toContain(`to: '/mon-espace/climat'`)
    expect(appTsx).toContain('MonClimat')
    expect(appTsx).toContain(`path="climat"`)
  })
})

describe('GOLDEN climate — endpoints consommés', () => {
  it('RH : surveys + résultats ; employé : my-surveys + responses', () => {
    expect(rhPage).toContain(`api.get('/climate/surveys')`)
    expect(rhPage).toContain(`api.post('/climate/surveys'`)
    expect(rhPage).toContain('/results')
    expect(selfPage).toContain(`api.get('/climate/my-surveys')`)
    expect(selfPage).toContain('/responses')
    expect(routes).toContain(`fastify.get('/surveys/:id/results'`)
    expect(routes).toContain(`fastify.get('/my-surveys'`)
    expect(routes).toContain(`fastify.post('/surveys/:id/responses'`)
  })
})

describe('GOLDEN climate — anonymat (OWASP A01 / confidentialité)', () => {
  it('les résultats agrègent sans exposer employee_id', () => {
    expect(routes).toContain('aggregateResults')
    expect(routes).toContain('SELECT answers FROM')
    // la requête de résultats ne doit pas sélectionner employee_id
    const resultsBlock = routes.slice(routes.indexOf("get('/surveys/:id/results'"), routes.indexOf("get('/my-surveys'"))
    expect(resultsBlock).not.toContain('SELECT employee_id')
  })
})

describe('GOLDEN climate — i18n FR/EN', () => {
  it('namespace enregistré + labels nav, sans BOM', () => {
    expect(i18nIndex).toMatch(/climate/)
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'climate.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      expect(JSON.parse(readWeb('i18n', 'locales', lang, 'nav.json'))['climate']).toBeDefined()
      expect((JSON.parse(readWeb('i18n', 'locales', lang, 'monEspace.json'))['nav'] as Record<string, unknown>)['climate']).toBeDefined()
    }
  })
})

describe('GOLDEN climate — tables provisionnée + migrée lazy', () => {
  it('climate_surveys + climate_responses dans provisioning ET migration', () => {
    for (const tbl of ['climate_surveys', 'climate_responses']) {
      expect(provisioning).toContain(tbl)
      expect(migrations).toContain(tbl)
    }
  })
})
