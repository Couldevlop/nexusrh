/**
 * GOLDEN — Contrat UI ↔ API du module Plans de succession.
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
const routes         = readApi('modules', 'succession', 'succession.routes.ts')
const migrations     = readApi('utils', 'schema-migrations.ts')
const provisioning   = readApi('db', 'provisioning.ts')
const webModules     = readWeb('lib', 'modules.ts')
const sidebar        = readWeb('components', 'layout', 'Sidebar.tsx')
const appTsx         = readWeb('App.tsx')
const page           = readWeb('pages', 'succession', 'SuccessionPage.tsx')
const i18nIndex      = readWeb('i18n', 'index.ts')

describe('GOLDEN succession — clé de module alignée API ↔ web', () => {
  it("'succession' clé canonique API + web (actif par défaut)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('succession')).toBe(true)
    expect(webModules).toContain(`'succession'`)
    expect(webModules).toMatch(/succession:\s+true/)
  })
  it('mapping URL + enregistrement route', () => {
    expect(modulesService).toContain(`['/succession',       'succession']`)
    expect(appTs).toContain('successionRoutes')
    expect(appTs).toMatch(/register\(successionRoutes,\s*\{\s*prefix:\s*'\/succession'\s*\}\)/)
  })
})

describe('GOLDEN succession — sidebar & route protégées', () => {
  it('entrée sidebar gatée rôle + module', () => {
    expect(sidebar).toContain(`to: '/succession'`)
    expect(sidebar).toContain(`labelKey: 'succession'`)
    expect(sidebar).toContain(`moduleKey: 'succession'`)
  })
  it('route protégée par RoleGuard + ModuleGuard succession', () => {
    expect(appTsx).toContain('SuccessionPage')
    expect(appTsx).toMatch(/path="succession"[\s\S]{0,220}moduleKey="succession"/)
  })
})

describe('GOLDEN succession — endpoints consommés', () => {
  it('plans + candidats', () => {
    expect(page).toContain(`api.get('/succession/plans')`)
    expect(page).toContain(`api.post('/succession/plans'`)
    expect(page).toContain('/candidates')
    expect(routes).toContain(`fastify.post('/plans/:id/candidates'`)
    expect(routes).toContain(`fastify.patch('/candidates/:id'`)
    expect(routes).toContain('summarizeCoverage')
  })
})

describe('GOLDEN succession — i18n FR/EN', () => {
  it('namespace enregistré + labels nav, sans BOM', () => {
    expect(i18nIndex).toMatch(/succession/)
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'succession.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      expect(JSON.parse(readWeb('i18n', 'locales', lang, 'nav.json'))['succession']).toBeDefined()
    }
  })
})

describe('GOLDEN succession — tables provisionnée + migrée lazy', () => {
  it('succession_plans + succession_candidates dans provisioning ET migration', () => {
    for (const tbl of ['succession_plans', 'succession_candidates']) {
      expect(provisioning).toContain(tbl)
      expect(migrations).toContain(tbl)
    }
  })
})
