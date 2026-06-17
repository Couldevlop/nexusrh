/**
 * GOLDEN — Contrat UI ↔ API du module Interface SAGE.
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
const routes         = readApi('modules', 'sage', 'sage.routes.ts')
const migrations     = readApi('utils', 'schema-migrations.ts')
const provisioning   = readApi('db', 'provisioning.ts')
const webModules     = readWeb('lib', 'modules.ts')
const sidebar        = readWeb('components', 'layout', 'Sidebar.tsx')
const appTsx         = readWeb('App.tsx')
const page           = readWeb('pages', 'sage', 'SagePage.tsx')
const i18nIndex      = readWeb('i18n', 'index.ts')

describe('GOLDEN sage — clé de module alignée API ↔ web', () => {
  it("'sage' clé canonique API + web (actif par défaut)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('sage')).toBe(true)
    expect(webModules).toContain(`'sage'`)
    expect(webModules).toMatch(/sage:\s+true/)
  })
  it('mapping URL + enregistrement route', () => {
    expect(modulesService).toContain(`['/sage',             'sage']`)
    expect(appTs).toContain('sageRoutes')
    expect(appTs).toMatch(/register\(sageRoutes,\s*\{\s*prefix:\s*'\/sage'\s*\}\)/)
  })
})

describe('GOLDEN sage — sidebar & route protégées', () => {
  it('entrée sidebar gatée rôle + module', () => {
    expect(sidebar).toContain(`to: '/sage'`)
    expect(sidebar).toContain(`labelKey: 'sage'`)
    expect(sidebar).toContain(`moduleKey: 'sage'`)
  })
  it('route protégée par RoleGuard + ModuleGuard sage', () => {
    expect(appTsx).toContain('SagePage')
    expect(appTsx).toMatch(/path="sage"[\s\S]{0,240}moduleKey="sage"/)
  })
})

describe('GOLDEN sage — endpoints consommés', () => {
  it('config + 3 exports', () => {
    expect(page).toContain(`api.get('/sage/config')`)
    expect(page).toContain(`api.put('/sage/config'`)
    expect(page).toContain('/sage/export/employees.csv')
    expect(routes).toContain(`fastify.get('/export/employees.csv'`)
    expect(routes).toContain(`fastify.get('/export/variable-elements.csv'`)
    expect(routes).toContain(`fastify.get('/export/payroll.csv'`)
  })
  it('réservé admin/hr_manager (A01), exports audités (A09)', () => {
    expect(routes).toContain('CONFIG_ROLES')
    expect(routes).toContain(`'sage.export_employees'`)
    expect(routes).toContain(`'sage.export_payroll'`)
  })
})

describe('GOLDEN sage — i18n FR/EN', () => {
  it('namespace enregistré + label nav, sans BOM', () => {
    expect(i18nIndex).toMatch(/sage/)
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'sage.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      expect(JSON.parse(readWeb('i18n', 'locales', lang, 'nav.json'))['sage']).toBeDefined()
    }
  })
})

describe('GOLDEN sage — table provisionnée + migrée lazy', () => {
  it('sage_config', () => {
    expect(provisioning).toContain('sage_config')
    expect(migrations).toContain('sage_config')
  })
})
