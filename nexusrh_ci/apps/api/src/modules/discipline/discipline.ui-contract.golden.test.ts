/**
 * GOLDEN — Contrat UI ↔ API du module Gestion disciplinaire.
 *
 * Invariants :
 *  1. Clé de module 'discipline' alignée API ↔ web + mapping + enregistrement.
 *  2. Sidebar + route protégées (RoleGuard + ModuleGuard), i18n FR/EN.
 *  3. La page consomme les endpoints exposés.
 *  4. SÉCURITÉ niveau 4 (OWASP A01) : lecture restreinte à admin/hr_manager/
 *     hr_officer (JAMAIS manager/employee/readonly) ; suppression admin/hr_manager.
 *  5. Table provisionnée (nouveau tenant) ET migrée lazy (tenants existants).
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
const routes         = readApi('modules', 'discipline', 'discipline.routes.ts')
const migrations     = readApi('utils', 'schema-migrations.ts')
const provisioning   = readApi('db', 'provisioning.ts')
const webModules     = readWeb('lib', 'modules.ts')
const sidebar        = readWeb('components', 'layout', 'Sidebar.tsx')
const appTsx         = readWeb('App.tsx')
const page           = readWeb('pages', 'discipline', 'DisciplinePage.tsx')
const i18nIndex      = readWeb('i18n', 'index.ts')

describe('GOLDEN discipline — clé de module alignée API ↔ web', () => {
  it("'discipline' clé canonique API + web (actif par défaut)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('discipline')).toBe(true)
    expect(webModules).toContain(`'discipline'`)
    expect(webModules).toMatch(/discipline:\s+true/)
  })
  it('mapping URL + enregistrement route', () => {
    expect(modulesService).toContain(`['/discipline',       'discipline']`)
    expect(appTs).toContain('disciplineRoutes')
    expect(appTs).toMatch(/register\(disciplineRoutes,\s*\{\s*prefix:\s*'\/discipline'\s*\}\)/)
  })
})

describe('GOLDEN discipline — sidebar & route protégées', () => {
  it('entrée sidebar gatée rôle + module', () => {
    expect(sidebar).toContain(`to: '/discipline'`)
    expect(sidebar).toContain(`labelKey: 'discipline'`)
    expect(sidebar).toContain(`moduleKey: 'discipline'`)
  })
  it('route protégée par RoleGuard + ModuleGuard discipline', () => {
    expect(appTsx).toContain('DisciplinePage')
    expect(appTsx).toMatch(/path="discipline"[\s\S]{0,220}moduleKey="discipline"/)
  })
})

describe('GOLDEN discipline — la page consomme les endpoints exposés', () => {
  it('liste + création + endpoints discipline', () => {
    expect(page).toContain(`api.get('/discipline')`)
    expect(page).toContain(`api.post('/discipline'`)
    expect(page).toContain('/discipline/')
    expect(routes).toContain(`fastify.get('/'`)
    expect(routes).toContain(`fastify.post('/'`)
    expect(routes).toContain(`fastify.patch('/:id'`)
    expect(routes).toContain(`fastify.delete('/:id'`)
  })
})

describe('GOLDEN discipline — i18n FR/EN', () => {
  it('namespace discipline enregistré + labels nav présents, sans BOM', () => {
    expect(i18nIndex).toMatch(/discipline/)
    for (const lang of ['fr', 'en']) {
      expect(existsSync(join(WEB_SRC, 'i18n', 'locales', lang, 'discipline.json'))).toBe(true)
      const nav = readWeb('i18n', 'locales', lang, 'discipline.json')
      expect(nav.charCodeAt(0)).not.toBe(0xfeff)
      expect(JSON.parse(readWeb('i18n', 'locales', lang, 'nav.json'))['discipline']).toBeDefined()
    }
  })
})

describe('GOLDEN discipline — sécurité niveau 4 (OWASP A01)', () => {
  it('lecture restreinte à admin/hr_manager/hr_officer (jamais manager/employee/readonly)', () => {
    expect(routes).toContain(`const READ_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const`)
    const readDecl = routes.slice(routes.indexOf('READ_ROLES ='), routes.indexOf('READ_ROLES =') + 80)
    expect(readDecl).not.toContain('manager,') // 'manager' isolé (hr_manager reste autorisé)
    expect(readDecl).not.toContain('employee')
    expect(readDecl).not.toContain('readonly')
  })
  it('suppression réservée admin/hr_manager', () => {
    expect(routes).toContain(`const DELETE_ROLES = ['admin', 'hr_manager'] as const`)
  })
})

describe('GOLDEN discipline — table provisionnée + migrée lazy', () => {
  it('CREATE TABLE disciplinary_actions dans provisioning ET migration lazy', () => {
    expect(provisioning).toContain('disciplinary_actions')
    expect(migrations).toContain('disciplinary_actions')
  })
})
