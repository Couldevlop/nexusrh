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
  it('routes internes offre-scopées + config', () => {
    expect(routes).toContain(`fastify.get('/internal-jobs/:jobId/start'`)
    expect(routes).toContain(`fastify.post('/internal-jobs/:jobId/submit'`)
    expect(routes).toContain(`fastify.get('/config'`)
    expect(routes).toContain(`fastify.put('/config'`)
  })
  it('plugin public séparé à jeton', () => {
    expect(routes).toContain('export const interviewSimPublicRoutes')
    expect(routes).toContain(`fastify.get('/:token'`)
    expect(routes).toContain(`fastify.post('/:token/submit'`)
  })
  it('flux interne éphémère : aucune référence à interview_sim_attempts dans les routes', () => {
    // Les routes offre-scopées ne persistent rien (RGPD, décision 2026-07-23).
    // (La route /config garde son INSERT INTO interview_sim_config — non concerné.)
    expect(routes).not.toContain('interview_sim_attempts')
    expect(routes).toContain(`incrementUsage(normalizeRoleKey(`)
  })
  it('routes de consentement RGPD : preuve interne, texte partagé (tout rôle), preuve publique', () => {
    expect(routes).toContain(`fastify.post('/internal-jobs/:jobId/consent'`)
    expect(routes).toContain(`fastify.get('/consent-text'`)
    expect(routes).toContain(`fastify.post('/:token/consent'`)
  })
  it('blocage 403 « Consentement requis » sur start (interne), submit (interne) et submit (public)', () => {
    const enforcement = routes.match(/reply\.status\(403\)\.send\(\{ error: 'Consentement requis' \}\)/g) ?? []
    // start (sessionId absent + sessionId non tracé) + submit interne + submit public = 4 gardes.
    expect(enforcement.length).toBeGreaterThanOrEqual(4)
    // start ET submit interne s'appuient sur la MÊME vérification (hasInternalConsent) —
    // l'une ne doit jamais être moins stricte que l'autre.
    expect(routes).toContain('hasInternalConsent(schema, sessionId, jobId, employeeId)')
    expect(routes).toContain('hasInternalConsent(schema, body.sessionId, jobId, employeeId)')
    // submit public : lookup direct dans interview_sim_consents (scope='public').
    expect(routes).toMatch(/FROM "\$\{claims\.schema\}"\.interview_sim_consents[\s\S]{0,120}scope = 'public'/)
  })
  it('trace publique STRICTEMENT ANONYME : employee_id NULL en dur, aucune IP insérée', () => {
    const marker = `VALUES ('public', NULL, $1, $2, $3) RETURNING id`
    expect(routes).toContain(marker)
    // Fenêtre couvrant l'INSERT + son tableau de paramètres liés (juste après le
    // literal SQL ci-dessus) — doit être exempte de toute trace d'IP/en-tête réseau.
    const idx = routes.indexOf(marker)
    const insertBlock = routes.slice(idx, idx + 300)
    expect(insertBlock).not.toContain('request.ip')
    expect(insertBlock).not.toContain('x-forwarded-for')
    expect(insertBlock).not.toContain('.ip)')
    expect(insertBlock).not.toContain('ipAddress')
  })
})

describe('GOLDEN interview_sim — web (self-service /mon-espace + page publique)', () => {
  it('bouton entretien sur la fiche offre interne (plus de menu self-service)', () => {
    const offres = readWeb('pages', 'mon-espace', 'MesOffresInternes.tsx')
    expect(offres).toContain('OfferInterviewRunner')
    expect(offres).toContain(`t('offers.trainInterview')`)
    // Module opt-in (défaut désactivé) : le bouton doit rester gardé côté web
    // — c'était l'unique garde front avant la refonte (menu self-service retiré).
    expect(offres).toContain('isModuleEnabled')
    expect(offres).toContain("'interview_sim'")
    expect(employeeLayout).not.toContain(`to: '/mon-espace/simulations'`)
    expect(appTsx).not.toContain('MesSimulations')
  })
  it('page publique inchangée + composant de restitution partagé', () => {
    expect(appTsx).toContain('PublicInterviewSimPage')
    expect(appTsx).toContain('/entrainement-entretien/:token')
    const runner = readWeb('components', 'interview-sim', 'OfferInterviewRunner.tsx')
    expect(runner).toContain('InterviewRestitution')
  })
})

describe('GOLDEN interview_sim — i18n FR/EN', () => {
  it('namespace enregistré + libellés entretien par offre, sans BOM', () => {
    expect(i18nIndex).toMatch(/interviewSim/)
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'interviewSim.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      const off = JSON.parse(readWeb('i18n', 'locales', lang, 'monEspace.json')) as { offers?: Record<string, unknown>; nav?: Record<string, unknown> }
      expect(off.offers?.trainInterview).toBeDefined()
      expect(off.offers?.backToOffer).toBeDefined()
      expect(off.nav?.interviewSim).toBeUndefined()
    }
  })
})

describe('GOLDEN interview_sim — persistance provisionnée + migrée + seedée', () => {
  it('banque platform + config tenant provisionnées ; historique attempts SUPPRIMÉ (RGPD)', () => {
    expect(provisioning).toContain('platform.interview_sim_question_banks')
    expect(provisioning).not.toMatch(/CREATE TABLE[\s\S]{0,20}interview_sim_attempts/)
    expect(migrations).toContain('platform.interview_sim_question_banks')
    expect(migrations).toContain('DROP TABLE IF EXISTS "${schemaName}".interview_sim_attempts')
    expect(migrations).toContain('interview_sim_config')
  })
  it('banque de démo amorcée', () => {
    expect(seed).toContain('interview_sim_question_banks')
  })
  it('trace de consentement RGPD provisionnée + migrée ; rétention paramétrable par tenant', () => {
    expect(provisioning).toContain('interview_sim_consents')
    expect(provisioning).toContain('consent_retention_months')
    expect(migrations).toContain('interview_sim_consents')
    expect(migrations).toContain('consent_retention_months')
    // interview_sim_attempts reste supprimé même après l'ajout du consentement :
    // la migration DROP la table (héritage historique), la provisioning ne la
    // (re)crée jamais — voir aussi l'assertion jumelle ci-dessus (routes).
    expect(migrations).toContain('DROP TABLE IF EXISTS "${schemaName}".interview_sim_attempts')
    expect(provisioning).not.toMatch(/CREATE TABLE[\s\S]{0,20}interview_sim_attempts/)
  })
})
