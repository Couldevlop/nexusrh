/**
 * GOLDEN — Contrat UI ↔ API du module Calibrage (9-box).
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
const routes         = readApi('modules', 'calibration', 'calibration.routes.ts')
const migrations     = readApi('utils', 'schema-migrations.ts')
const provisioning   = readApi('db', 'provisioning.ts')
const webModules     = readWeb('lib', 'modules.ts')
const sidebar        = readWeb('components', 'layout', 'Sidebar.tsx')
const appTsx         = readWeb('App.tsx')
const page           = readWeb('pages', 'calibration', 'CalibrationPage.tsx')
const i18nIndex      = readWeb('i18n', 'index.ts')

describe('GOLDEN calibration — clé de module alignée API ↔ web', () => {
  it("'calibration' clé canonique API + web (actif par défaut)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('calibration')).toBe(true)
    expect(webModules).toContain(`'calibration'`)
    expect(webModules).toMatch(/calibration:\s+true/)
  })
  it('mapping URL + enregistrement route', () => {
    expect(modulesService).toContain(`['/calibration',      'calibration']`)
    expect(appTs).toContain('calibrationRoutes')
    expect(appTs).toMatch(/register\(calibrationRoutes,\s*\{\s*prefix:\s*'\/calibration'\s*\}\)/)
  })
})

describe('GOLDEN calibration — sidebar & route protégées', () => {
  it('entrée sidebar gatée rôle + module', () => {
    expect(sidebar).toContain(`to: '/calibration'`)
    expect(sidebar).toContain(`labelKey: 'calibration'`)
    expect(sidebar).toContain(`moduleKey: 'calibration'`)
  })
  it('route protégée par RoleGuard + ModuleGuard calibration', () => {
    expect(appTsx).toContain('CalibrationPage')
    expect(appTsx).toMatch(/path="calibration"[\s\S]{0,240}moduleKey="calibration"/)
  })
})

describe('GOLDEN calibration — endpoints consommés', () => {
  it('sessions + entrées', () => {
    expect(page).toContain(`api.get('/calibration/sessions')`)
    expect(page).toContain(`api.post('/calibration/sessions'`)
    expect(page).toContain('/entries')
    expect(routes).toContain(`fastify.post('/sessions/:id/entries'`)
    expect(routes).toContain(`fastify.patch('/entries/:id'`)
    expect(routes).toContain('summarizeSession')
  })
})

describe('GOLDEN calibration — i18n FR/EN', () => {
  it('namespace enregistré + 9 cases 9-box + label nav, sans BOM', () => {
    expect(i18nIndex).toMatch(/calibration/)
    const keys = ['star', 'high_perf', 'expert', 'high_pot', 'core', 'solid', 'enigma', 'inconsistent', 'risk']
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'calibration.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      const dict = JSON.parse(raw) as { box?: Record<string, unknown> }
      for (const k of keys) expect(dict.box?.[k]).toBeDefined()
      expect(JSON.parse(readWeb('i18n', 'locales', lang, 'nav.json'))['calibration']).toBeDefined()
    }
  })
})

describe('GOLDEN calibration — tables provisionnée + migrée lazy', () => {
  it('calibration_sessions + calibration_entries', () => {
    for (const tbl of ['calibration_sessions', 'calibration_entries']) {
      expect(provisioning).toContain(tbl)
      expect(migrations).toContain(tbl)
    }
  })
})
