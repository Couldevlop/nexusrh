/**
 * Golden — Soumission de TOUS les formulaires (bout-à-bout sur `buildApp()`).
 *
 * Filet de non-régression « formulaires » : pour chaque endpoint de soumission
 * (POST/PATCH/PUT) de l'application, on vérifie deux invariants STABLES (sans
 * dépendre du contenu exact de la base, mockée en lignes vides) :
 *
 *   1. PROTECTION — appelé SANS token => 401. Prouve que le formulaire est monté
 *      (sinon 404) ET protégé (auth appliquée en amont du handler).
 *   2. ROBUSTESSE — appelé AVEC un token valide mais un corps INVALIDE => réponse
 *      < 500. Prouve que le formulaire valide/traite une saisie malformée sans
 *      jamais faire planter le serveur (OWASP A03/A05 : pas de 500 non maîtrisé).
 *      Un 404 « ressource introuvable » (UUID inexistant, base vide) est légitime
 *      ici : le montage est déjà prouvé par le check #1.
 *
 * Les formulaires publics d'authentification (login/forgot/reset) n'ont pas de
 * garde 401 : on vérifie seulement qu'ils sont montés et robustes (corps invalide
 * => réponse < 500, jamais 404). forgot-password renvoie 200 par anti-énumération.
 *
 * Isolation : VRAI config.ts + buildApp() ; seuls pg (lignes vides) et redis sont
 * mockés. Les endpoints d'upload multipart et les appels IA/externes sont exclus
 * (parser binaire / services tiers non pertinents pour ce filet).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.hoisted(() => {
  process.env.NODE_ENV     = 'test'
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5434/test'
  process.env.JWT_SECRET   = 'golden-forms-secret-minimum-32-characters!!'
  process.env.LOG_LEVEL    = 'silent'
})

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn().mockResolvedValue({ rows: [] }),
}))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn(), connect: vi.fn() })),
}))

vi.mock('./services/redis.js', () => ({
  redis:              { quit: vi.fn(), disconnect: vi.fn() },
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  redisLockoutStore:  {},
}))

vi.mock('./services/email.js', () => ({
  sendEmployeeWelcomeEmail:   vi.fn().mockResolvedValue(undefined),
  sendWelcomeTenantEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetLinkEmail: vi.fn().mockResolvedValue(undefined),
}))

import { buildApp } from './app.js'

type Scope = 'tenant' | 'platform' | 'authed' | 'public'
interface FormEndpoint {
  method: 'POST' | 'PATCH' | 'PUT'
  url:    string
  scope:  Scope
}

const UUID = '00000000-0000-0000-0000-000000000000'

// Formulaires représentatifs de CHAQUE module (create/submit/patch).
const FORMS: FormEndpoint[] = [
  // Auth publics
  { method: 'POST', url: '/auth/login',           scope: 'public' },
  { method: 'POST', url: '/auth/forgot-password', scope: 'public' },
  { method: 'POST', url: '/auth/reset-password',  scope: 'public' },
  // Auth authentifié
  { method: 'POST', url: '/auth/change-password', scope: 'authed' },
  // Employés
  { method: 'POST',  url: '/employees',          scope: 'tenant' },
  { method: 'PATCH', url: `/employees/${UUID}`,  scope: 'tenant' },
  // Absences
  { method: 'POST',  url: '/absences',                 scope: 'tenant' },
  { method: 'PATCH', url: `/absences/${UUID}/approve`, scope: 'tenant' },
  { method: 'PATCH', url: `/absences/${UUID}/reject`,  scope: 'tenant' },
  // Notes de frais
  { method: 'POST',  url: '/expenses',                 scope: 'tenant' },
  { method: 'POST',  url: `/expenses/${UUID}/lines`,   scope: 'tenant' },
  { method: 'PATCH', url: `/expenses/${UUID}/submit`,  scope: 'tenant' },
  { method: 'PATCH', url: `/expenses/${UUID}/approve`, scope: 'tenant' },
  // Paramétrage tenant
  { method: 'PATCH', url: '/settings/tenant',            scope: 'tenant' },
  { method: 'POST',  url: '/settings/users',             scope: 'tenant' },
  { method: 'POST',  url: '/settings/departments',       scope: 'tenant' },
  { method: 'POST',  url: '/settings/absence-types',     scope: 'tenant' },
  { method: 'POST',  url: '/settings/payroll-rules',     scope: 'tenant' },
  { method: 'POST',  url: '/settings/legal-entities',    scope: 'tenant' },
  { method: 'PATCH', url: '/settings/workflow',          scope: 'tenant' },
  { method: 'POST',  url: '/settings/variable-elements', scope: 'tenant' },
  // Carrières / compétences
  { method: 'POST', url: '/careers/skills',          scope: 'tenant' },
  { method: 'PUT',  url: '/careers/employee-skills', scope: 'tenant' },
  { method: 'POST', url: '/careers/evaluations',     scope: 'tenant' },
  // Formation
  { method: 'POST', url: '/training/catalog',      scope: 'tenant' },
  { method: 'POST', url: '/training/sessions',     scope: 'tenant' },
  { method: 'POST', url: '/training/enroll',       scope: 'tenant' },
  { method: 'POST', url: '/training/fdfp/request', scope: 'tenant' },
  // Recrutement
  { method: 'POST', url: '/recruitment/jobs',                   scope: 'tenant' },
  { method: 'POST', url: '/recruitment/applications',           scope: 'tenant' },
  { method: 'POST', url: `/recruitment/jobs/${UUID}/preselect`, scope: 'tenant' },
  // Contrats
  { method: 'POST', url: '/contracts',                   scope: 'tenant' },
  { method: 'POST', url: `/contracts/${UUID}/terminate`, scope: 'tenant' },
  { method: 'POST', url: `/contracts/${UUID}/renew`,     scope: 'tenant' },
  // CNPS / DISA
  { method: 'POST', url: '/cnps/declarations/generate', scope: 'tenant' },
  { method: 'POST', url: '/cnps/disa/generate',         scope: 'tenant' },
  { method: 'POST', url: '/cnps/events/cessation',      scope: 'tenant' },
  // Paie
  { method: 'POST', url: '/payroll/calculate',             scope: 'tenant' },
  { method: 'POST', url: '/payroll/simulate',              scope: 'tenant' },
  { method: 'POST', url: '/payroll/periods/2024-07/close', scope: 'tenant' },
  { method: 'POST', url: '/payroll-workflow/periods',      scope: 'tenant' },
  // Mobile Money
  { method: 'POST', url: '/mobile-money/campaigns', scope: 'tenant' },
  // Plateforme (super_admin)
  { method: 'POST',  url: '/platform/tenants',            scope: 'platform' },
  { method: 'PATCH', url: '/platform/settings',           scope: 'platform' },
  { method: 'PATCH', url: `/platform/tenants/${UUID}`,    scope: 'platform' },
  { method: 'POST',  url: '/platform/sourcing/models',    scope: 'platform' },
  { method: 'POST',  url: '/platform/sourcing/platforms', scope: 'platform' },
]

let app: FastifyInstance

function token(scope: Scope): string {
  const base = {
    sub: UUID, email: 'admin@tenant.test', firstName: 'A', lastName: 'B', employeeId: null,
  }
  if (scope === 'platform') {
    return app.jwt.sign({ ...base, tenantId: null, schemaName: 'platform', role: 'super_admin' })
  }
  return app.jwt.sign({ ...base, tenantId: 't1', schemaName: 'tenant_test', role: 'admin' })
}

describe('Golden Formulaires — toutes les soumissions montées, protégées et robustes', () => {
  beforeAll(async () => { app = await buildApp(); await app.ready() })
  afterAll(async () => { await app.close() })

  // 1. PROTECTION : sans token => 401 (sauf formulaires publics d'auth)
  describe('Protégés : sans token => 401 (monté + auth en amont)', () => {
    for (const f of FORMS.filter(x => x.scope !== 'public')) {
      it(`${f.method} ${f.url}`, async () => {
        const res = await app.inject({ method: f.method, url: f.url, payload: {} })
        expect(res.statusCode, `attendu 401, recu ${res.statusCode}`).toBe(401)
      })
    }
  })

  // 2. ROBUSTESSE : token valide + corps invalide => < 500 (jamais de crash)
  describe('Robustes : token + corps invalide => reponse < 500 (pas de crash)', () => {
    for (const f of FORMS.filter(x => x.scope === 'tenant' || x.scope === 'platform' || x.scope === 'authed')) {
      it(`${f.method} ${f.url}`, async () => {
        const res = await app.inject({
          method: f.method, url: f.url,
          headers: { authorization: `Bearer ${token(f.scope)}` },
          payload: { champ_invalide: ' ', n: Number.NaN },
        })
        // < 500 = aucun crash. Le montage est prouve par le check #1 ; un 404
        // « ressource introuvable » (UUID inexistant, base vide) est legitime.
        expect(res.statusCode, `${f.method} ${f.url} a renvoye ${res.statusCode}`).toBeLessThan(500)
      })
    }
  })

  // 3. Auth publics : montés + robustes (corps invalide => < 500, jamais 404)
  describe('Auth publics : corps invalide => reponse maitrisee (pas 404, pas 5xx)', () => {
    for (const f of FORMS.filter(x => x.scope === 'public')) {
      it(`${f.method} ${f.url}`, async () => {
        const res = await app.inject({ method: f.method, url: f.url, payload: { x: 1 } })
        expect(res.statusCode).not.toBe(404)
        expect(res.statusCode).toBeLessThan(500)
      })
    }
  })
})
