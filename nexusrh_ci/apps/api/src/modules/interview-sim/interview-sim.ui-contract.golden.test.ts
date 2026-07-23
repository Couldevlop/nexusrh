/**
 * GOLDEN — Contrat UI ↔ API du module Simulations d'entretien.
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
const appTs = readApi('app.ts')
const routes = readApi('modules', 'interview-sim', 'interview-sim.routes.ts')
const migrations = readApi('utils', 'schema-migrations.ts')
const provisioning = readApi('db', 'provisioning.ts')
const seed = readApi('db', 'seed.ts')
const webModules = readWeb('lib', 'modules.ts')
const employeeLayout = readWeb('components', 'layout', 'EmployeeLayout.tsx')
const appTsx = readWeb('App.tsx')
const i18nIndex = readWeb('i18n', 'index.ts')

describe('GOLDEN interview_sim — clé de module alignée API ↔ web', () => {
  it("'interview_sim' clé canonique API + web (opt-in par défaut)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('interview_sim')).toBe(true)
    expect(webModules).toContain(`'interview_sim'`)
    expect(webModules).toMatch(/interview_sim:\s+false/)
  })
  it('mapping URL + enregistrement des DEUX plugins (interne + public)', () => {
    expect(modulesService).toMatch(/\['\/interview-sim',\s*'interview_sim'\]/)
    expect(appTs).toContain('interviewSimRoutes')
    expect(appTs).toContain('interviewSimPublicRoutes')
    expect(appTs).toMatch(/register\(interviewSimRoutes,\s*\{\s*prefix:\s*'\/interview-sim'\s*\}\)/)
    expect(appTs).toMatch(/register\(interviewSimPublicRoutes,\s*\{\s*prefix:\s*'\/public\/interview-sim'\s*\}\)/)
  })
})

describe('GOLDEN interview_sim — endpoints', () => {
  it('routes internes + config', () => {
    expect(routes).toContain(`fastify.get('/start'`)
    expect(routes).toContain(`fastify.post('/attempts/submit'`)
    expect(routes).toContain(`fastify.get('/my-attempts'`)
    expect(routes).toContain(`fastify.delete('/my-attempts/:id'`)
    expect(routes).toContain(`fastify.get('/config'`)
    expect(routes).toContain(`fastify.put('/config'`)
  })
  it('plugin public séparé à jeton', () => {
    expect(routes).toContain('export const interviewSimPublicRoutes')
    expect(routes).toContain(`fastify.get('/:token'`)
    expect(routes).toContain(`fastify.post('/:token/submit'`)
  })
  it('isolation employee_id (jamais le body) + effacement', () => {
    expect(routes).toContain('employee_id = $2')
    expect(routes).toContain('DELETE FROM')
  })
})

describe('GOLDEN interview_sim — web (self-service /mon-espace + page publique)', () => {
  it('entrée nav mon-espace gatée module', () => {
    expect(employeeLayout).toContain(`to: '/mon-espace/simulations'`)
    expect(employeeLayout).toContain(`labelKey: 'nav.interviewSim'`)
    expect(employeeLayout).toContain(`moduleKey: 'interview_sim'`)
  })
  it('route interne mon-espace + route publique', () => {
    expect(appTsx).toContain('MesSimulations')
    expect(appTsx).toContain(`path="simulations"`)
    expect(appTsx).toContain('PublicInterviewSimPage')
    expect(appTsx).toContain('/entrainement-entretien/:token')
  })
})

describe('GOLDEN interview_sim — i18n FR/EN', () => {
  it('namespace enregistré + nav mon-espace, sans BOM', () => {
    expect(i18nIndex).toMatch(/interviewSim/)
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'interviewSim.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      const nav = JSON.parse(readWeb('i18n', 'locales', lang, 'monEspace.json')) as { nav?: Record<string, unknown> }
      expect(nav.nav?.interviewSim).toBeDefined()
    }
  })
})

describe('GOLDEN interview_sim — persistance provisionnée + migrée + seedée', () => {
  it('banque platform + historique tenant + config', () => {
    expect(provisioning).toContain('platform.interview_sim_question_banks')
    expect(provisioning).toContain('interview_sim_attempts')
    expect(migrations).toContain('platform.interview_sim_question_banks')
    expect(migrations).toContain('interview_sim_attempts')
    expect(migrations).toContain('interview_sim_config')
  })
  it('banque de démo amorcée', () => {
    expect(seed).toContain('interview_sim_question_banks')
  })
})
