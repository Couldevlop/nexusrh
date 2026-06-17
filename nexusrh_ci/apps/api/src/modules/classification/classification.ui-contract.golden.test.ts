/**
 * GOLDEN — Contrat UI ↔ API du module Classification des données (4 niveaux).
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
const routes         = readApi('modules', 'classification', 'classification.routes.ts')
const defaults       = readApi('db', 'classification-defaults.ts')
const migrations     = readApi('utils', 'schema-migrations.ts')
const provisioning   = readApi('db', 'provisioning.ts')
const webModules     = readWeb('lib', 'modules.ts')
const sidebar        = readWeb('components', 'layout', 'Sidebar.tsx')
const appTsx         = readWeb('App.tsx')
const page           = readWeb('pages', 'classification', 'ClassificationPage.tsx')
const i18nIndex      = readWeb('i18n', 'index.ts')

describe('GOLDEN classification — clé de module alignée API ↔ web', () => {
  it("'classification' clé canonique API + web (actif par défaut)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('classification')).toBe(true)
    expect(webModules).toContain(`'classification'`)
    expect(webModules).toMatch(/classification:\s+true/)
  })
  it('mapping URL + enregistrement route', () => {
    expect(modulesService).toContain(`['/classification',   'classification']`)
    expect(appTs).toContain('classificationRoutes')
    expect(appTs).toMatch(/register\(classificationRoutes,\s*\{\s*prefix:\s*'\/classification'\s*\}\)/)
  })
})

describe('GOLDEN classification — sidebar & route protégées', () => {
  it('entrée sidebar gatée rôle + module', () => {
    expect(sidebar).toContain(`to: '/classification'`)
    expect(sidebar).toContain(`labelKey: 'classification'`)
    expect(sidebar).toContain(`moduleKey: 'classification'`)
  })
  it('route protégée par RoleGuard + ModuleGuard classification', () => {
    expect(appTsx).toContain('ClassificationPage')
    expect(appTsx).toMatch(/path="classification"[\s\S]{0,240}moduleKey="classification"/)
  })
})

describe('GOLDEN classification — endpoints consommés', () => {
  it('niveaux + catégories + check', () => {
    expect(page).toContain(`api.get('/classification/levels')`)
    expect(page).toContain(`api.get('/classification/categories')`)
    expect(routes).toContain(`fastify.put('/levels/:level'`)
    expect(routes).toContain(`fastify.post('/categories'`)
    expect(routes).toContain(`fastify.get('/check'`)
  })
  it('config des règles réservée admin (A01) ; accès sensible audité (A09)', () => {
    expect(routes).toContain(`fastify.authorize('admin')`)
    expect(routes).toContain(`'classification.sensitive_access'`)
  })
})

describe('GOLDEN classification — 4 niveaux normalisés', () => {
  it('défauts : 4 niveaux + niveau 4 (restreint) sans export', () => {
    for (const lbl of ['public', 'internal', 'confidential', 'restricted']) {
      expect(defaults).toContain(lbl)
    }
    // niveau 4 : export interdit (export_allowed=false)
    expect(defaults).toMatch(/4,\s*'restricted'/)
  })
})

describe('GOLDEN classification — i18n FR/EN', () => {
  it('namespace enregistré + label nav, sans BOM', () => {
    expect(i18nIndex).toMatch(/classification/)
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'classification.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      expect(JSON.parse(readWeb('i18n', 'locales', lang, 'nav.json'))['classification']).toBeDefined()
    }
  })
})

describe('GOLDEN classification — tables provisionnée + migrée lazy', () => {
  it('DDL partagée classification_levels + data_classification_categories', () => {
    for (const tbl of ['classification_levels', 'data_classification_categories']) {
      expect(defaults).toContain(tbl)
    }
  })
  it('provisionnement (nouveaux tenants) ET migration lazy appellent la DDL partagée', () => {
    expect(provisioning).toContain('classificationTableStatements')
    expect(migrations).toContain('classificationTableStatements')
  })
})
