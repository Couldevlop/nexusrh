/**
 * GOLDEN — Contrat UI ↔ API du module Mobilités.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { MODULE_KEYS } from '../../services/tenant-modules.service.js'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WEB_SRC = join(API_SRC, '..', '..', '..', 'apps', 'web', 'src')
const readApi = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')
const readWeb = (...p: string[]) => readFileSync(join(WEB_SRC, ...p), 'utf8')

const modulesService = readApi('services', 'tenant-modules.service.ts')
const appTs          = readApi('app.ts')
const routes         = readApi('modules', 'mobility', 'mobility.routes.ts')
const migrations     = readApi('utils', 'schema-migrations.ts')
const provisioning   = readApi('db', 'provisioning.ts')
const webModules     = readWeb('lib', 'modules.ts')
const sidebar        = readWeb('components', 'layout', 'Sidebar.tsx')
const appTsx         = readWeb('App.tsx')
const page           = readWeb('pages', 'mobility', 'MobilityPage.tsx')
const i18nIndex      = readWeb('i18n', 'index.ts')

describe('GOLDEN mobility — clé de module alignée API ↔ web', () => {
  it("'mobility' clé canonique API + web (actif par défaut)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('mobility')).toBe(true)
    expect(webModules).toContain(`'mobility'`)
    expect(webModules).toMatch(/mobility:\s+true/)
  })
  it('mapping URL + enregistrement route', () => {
    expect(modulesService).toContain(`['/mobility',         'mobility']`)
    expect(appTs).toContain('mobilityRoutes')
    expect(appTs).toMatch(/register\(mobilityRoutes,\s*\{\s*prefix:\s*'\/mobility'\s*\}\)/)
  })
})

describe('GOLDEN mobility — sidebar & route protégées', () => {
  it('entrée sidebar gatée rôle + module', () => {
    expect(sidebar).toContain(`to: '/mobility'`)
    expect(sidebar).toContain(`labelKey: 'mobility'`)
    expect(sidebar).toContain(`moduleKey: 'mobility'`)
  })
  it('route protégée par RoleGuard + ModuleGuard mobility', () => {
    expect(appTsx).toContain('MobilityPage')
    expect(appTsx).toMatch(/path="mobility"[\s\S]{0,240}moduleKey="mobility"/)
  })
})

describe('GOLDEN mobility — endpoints consommés', () => {
  it('passerelles + évaluations + écart', () => {
    expect(page).toContain(`api.get('/mobility/requests')`)
    expect(page).toContain(`api.post('/mobility/requests'`)
    expect(page).toContain('/competencies')
    expect(routes).toContain(`fastify.put('/employees/:employeeId/competencies'`)
    expect(routes).toContain(`fastify.get('/employees/:employeeId/gap'`)
    expect(routes).toContain('gapAnalysis')
  })
  it('décision (approuvé/rejeté) réservée admin/hr_manager (A01)', () => {
    expect(routes).toContain('isDecision')
    expect(routes).toContain('DECIDE_ROLES')
  })
})

describe('GOLDEN mobility — i18n FR/EN', () => {
  it('namespace enregistré + label nav, sans BOM', () => {
    expect(i18nIndex).toMatch(/mobility/)
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'mobility.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      expect(JSON.parse(readWeb('i18n', 'locales', lang, 'nav.json'))['mobility']).toBeDefined()
    }
  })
})

describe('GOLDEN mobility — tables provisionnée + migrée lazy', () => {
  it('employee_competencies + mobility_requests', () => {
    for (const tbl of ['employee_competencies', 'mobility_requests']) {
      expect(provisioning).toContain(tbl)
      expect(migrations).toContain(tbl)
    }
  })
})
