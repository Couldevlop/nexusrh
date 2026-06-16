/**
 * GOLDEN — Contrat UI ↔ API du module Référentiel postes & compétences (Bloom).
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
const routes         = readApi('modules', 'competencies', 'competencies.routes.ts')
const migrations     = readApi('utils', 'schema-migrations.ts')
const provisioning   = readApi('db', 'provisioning.ts')
const webModules     = readWeb('lib', 'modules.ts')
const sidebar        = readWeb('components', 'layout', 'Sidebar.tsx')
const appTsx         = readWeb('App.tsx')
const page           = readWeb('pages', 'competencies', 'CompetenciesPage.tsx')
const i18nIndex      = readWeb('i18n', 'index.ts')

describe('GOLDEN competencies — clé de module alignée API ↔ web', () => {
  it("'competencies' clé canonique API + web (actif par défaut)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('competencies')).toBe(true)
    expect(webModules).toContain(`'competencies'`)
    expect(webModules).toMatch(/competencies:\s+true/)
  })
  it('mapping URL + enregistrement route', () => {
    expect(modulesService).toContain(`['/competencies',     'competencies']`)
    expect(appTs).toContain('competenciesRoutes')
    expect(appTs).toMatch(/register\(competenciesRoutes,\s*\{\s*prefix:\s*'\/competencies'\s*\}\)/)
  })
})

describe('GOLDEN competencies — sidebar & route protégées', () => {
  it('entrée sidebar gatée rôle + module', () => {
    expect(sidebar).toContain(`to: '/competencies'`)
    expect(sidebar).toContain(`labelKey: 'competencies'`)
    expect(sidebar).toContain(`moduleKey: 'competencies'`)
  })
  it('route protégée par RoleGuard + ModuleGuard competencies', () => {
    expect(appTsx).toContain('CompetenciesPage')
    expect(appTsx).toMatch(/path="competencies"[\s\S]{0,240}moduleKey="competencies"/)
  })
})

describe('GOLDEN competencies — endpoints consommés', () => {
  it('catalogue + fiches de poste + comparateur', () => {
    expect(page).toContain(`api.get('/competencies/catalog')`)
    expect(page).toContain(`api.post('/competencies/catalog'`)
    expect(page).toContain(`api.get('/competencies/job-profiles')`)
    expect(page).toContain('/competencies/compare?a=')
    expect(routes).toContain(`fastify.get('/compare'`)
    expect(routes).toContain(`fastify.post('/job-profiles/:id/competencies'`)
    expect(routes).toContain('compareRequirements')
  })
})

describe('GOLDEN competencies — i18n FR/EN', () => {
  it('namespace enregistré + labels nav + Bloom, sans BOM', () => {
    expect(i18nIndex).toMatch(/competencies/)
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'competencies.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      const dict = JSON.parse(raw) as { bloom?: Record<string, unknown> }
      // 6 niveaux de Bloom présents
      for (const n of [1, 2, 3, 4, 5, 6]) expect(dict.bloom?.[String(n)]).toBeDefined()
      expect(JSON.parse(readWeb('i18n', 'locales', lang, 'nav.json'))['competencies']).toBeDefined()
    }
  })
})

describe('GOLDEN competencies — tables provisionnée + migrée lazy', () => {
  it('job_profiles + competency_framework + job_profile_competencies', () => {
    for (const tbl of ['job_profiles', 'competency_framework', 'job_profile_competencies']) {
      expect(provisioning).toContain(tbl)
      expect(migrations).toContain(tbl)
    }
  })
})
