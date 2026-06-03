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
 * COUVERTURE : tous les POST/PATCH/PUT des modules, SAUF (raisons explicites) :
 *   - Upload multipart : /recruitment/.../upload-cv, /recruitment/public/.../apply,
 *     /settings/import/* (parser binaire — non pertinent pour ce filet) ;
 *   - Webhooks publics signés HMAC : /mobile-money/webhooks/:provider ;
 *   - Appels IA externes (Anthropic/Mistral) : /ai/chat (SSE), analyze-cv, source,
 *     source/compare (dépendances réseau tierces).
 *
 * Isolation : VRAI config.ts + buildApp() ; seuls pg (lignes vides) et redis sont
 * mockés. forgot-password renvoie 200 par anti-énumération (cf. check #3).
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

type Scope = 'tenant' | 'platform' | 'authed' | 'public' | 'agency'
interface FormEndpoint {
  method: 'POST' | 'PATCH' | 'PUT'
  url:    string
  scope:  Scope
}

const UUID = '00000000-0000-0000-0000-000000000000'

// TOUS les formulaires (create/submit/patch) de chaque module.
const FORMS: FormEndpoint[] = [
  // ── Auth publics ──
  { method: 'POST', url: '/auth/login',           scope: 'public' },
  { method: 'POST', url: '/auth/forgot-password', scope: 'public' },
  { method: 'POST', url: '/auth/reset-password',  scope: 'public' },
  // ── Auth authentifié ──
  { method: 'POST', url: '/auth/change-password', scope: 'authed' },
  // ── Employés ──
  { method: 'POST',  url: '/employees',         scope: 'tenant' },
  { method: 'PATCH', url: `/employees/${UUID}`, scope: 'tenant' },
  // ── Absences ──
  { method: 'POST',  url: '/absences',                 scope: 'tenant' },
  { method: 'PATCH', url: `/absences/${UUID}/approve`, scope: 'tenant' },
  { method: 'PATCH', url: `/absences/${UUID}/reject`,  scope: 'tenant' },
  // ── Notes de frais ──
  { method: 'POST',  url: '/expenses',                 scope: 'tenant' },
  { method: 'POST',  url: `/expenses/${UUID}/lines`,   scope: 'tenant' },
  { method: 'PATCH', url: `/expenses/${UUID}/submit`,  scope: 'tenant' },
  { method: 'PATCH', url: `/expenses/${UUID}/approve`, scope: 'tenant' },
  { method: 'PATCH', url: `/expenses/${UUID}/reject`,  scope: 'tenant' },
  { method: 'PATCH', url: `/expenses/${UUID}/pay`,     scope: 'tenant' },
  // ── Paramétrage tenant ──
  { method: 'PATCH', url: '/settings/tenant',                scope: 'tenant' },
  { method: 'POST',  url: '/settings/users',                scope: 'tenant' },
  { method: 'PATCH', url: `/settings/users/${UUID}`,        scope: 'tenant' },
  { method: 'POST',  url: `/settings/users/${UUID}/reset-password`, scope: 'tenant' },
  { method: 'POST',  url: '/settings/departments',          scope: 'tenant' },
  { method: 'PATCH', url: `/settings/departments/${UUID}`,  scope: 'tenant' },
  { method: 'POST',  url: '/settings/absence-types',        scope: 'tenant' },
  { method: 'PATCH', url: `/settings/absence-types/${UUID}`, scope: 'tenant' },
  { method: 'POST',  url: '/settings/payroll-rules',        scope: 'tenant' },
  { method: 'PATCH', url: `/settings/payroll-rules/${UUID}`, scope: 'tenant' },
  { method: 'POST',  url: '/settings/legal-entities',       scope: 'tenant' },
  { method: 'PATCH', url: `/settings/legal-entities/${UUID}`, scope: 'tenant' },
  { method: 'PATCH', url: '/settings/workflow',             scope: 'tenant' },
  { method: 'POST',  url: '/settings/variable-elements',    scope: 'tenant' },
  { method: 'PUT',   url: '/settings/ai',                   scope: 'tenant' },
  // ── Carrières / compétences ──
  { method: 'POST',  url: '/careers/skills',             scope: 'tenant' },
  { method: 'PUT',   url: '/careers/employee-skills',    scope: 'tenant' },
  { method: 'POST',  url: '/careers/evaluations',        scope: 'tenant' },
  { method: 'PATCH', url: `/careers/evaluations/${UUID}`, scope: 'tenant' },
  // ── Formation ──
  { method: 'POST', url: '/training/catalog',      scope: 'tenant' },
  { method: 'POST', url: '/training/sessions',     scope: 'tenant' },
  { method: 'POST', url: `/training/sessions/${UUID}/participants`, scope: 'tenant' },
  { method: 'POST', url: '/training/enroll',       scope: 'tenant' },
  { method: 'POST', url: '/training/fdfp/request', scope: 'tenant' },
  // ── Recrutement ──
  { method: 'POST',  url: '/recruitment/jobs',                    scope: 'tenant' },
  { method: 'PATCH', url: `/recruitment/jobs/${UUID}`,            scope: 'tenant' },
  { method: 'POST',  url: '/recruitment/applications',           scope: 'tenant' },
  { method: 'PATCH', url: `/recruitment/applications/${UUID}/stage`, scope: 'tenant' },
  { method: 'POST',  url: `/recruitment/jobs/${UUID}/preselect`, scope: 'tenant' },
  { method: 'PUT',   url: `/recruitment/jobs/${UUID}/screening-criteria`, scope: 'tenant' },
  { method: 'POST',  url: `/recruitment/internal-jobs/${UUID}/apply`, scope: 'tenant' },
  // ── Contrats ──
  { method: 'POST',  url: '/contracts',                   scope: 'tenant' },
  { method: 'PATCH', url: `/contracts/${UUID}`,           scope: 'tenant' },
  { method: 'POST',  url: `/contracts/${UUID}/terminate`, scope: 'tenant' },
  { method: 'POST',  url: `/contracts/${UUID}/renew`,     scope: 'tenant' },
  // ── CNPS / DISA ──
  { method: 'POST', url: '/cnps/declarations/generate',      scope: 'tenant' },
  { method: 'POST', url: `/cnps/declarations/${UUID}/submit`, scope: 'tenant' },
  { method: 'POST', url: '/cnps/disa/generate',             scope: 'tenant' },
  { method: 'POST', url: '/cnps/events/cessation',          scope: 'tenant' },
  // ── Paie ──
  { method: 'POST', url: '/payroll/calculate',              scope: 'tenant' },
  { method: 'POST', url: '/payroll/simulate',               scope: 'tenant' },
  { method: 'POST', url: '/payroll/periods/2024-07/close',  scope: 'tenant' },
  { method: 'POST', url: '/payroll/periods/2024-07/approve', scope: 'tenant' },
  { method: 'POST', url: '/payroll/periods/2024-07/reject', scope: 'tenant' },
  // ── Paie multi-filiales (workflow centralisé) ──
  { method: 'POST', url: '/payroll-workflow/periods',                    scope: 'tenant' },
  { method: 'POST', url: `/payroll-workflow/periods/${UUID}/send-to-sites`,   scope: 'tenant' },
  { method: 'POST', url: `/payroll-workflow/periods/${UUID}/submit-by-raf`,   scope: 'tenant' },
  { method: 'POST', url: `/payroll-workflow/periods/${UUID}/validate-central`, scope: 'tenant' },
  { method: 'POST', url: `/payroll-workflow/periods/${UUID}/close`,           scope: 'tenant' },
  // ── Mobile Money ──
  { method: 'POST',  url: '/mobile-money/campaigns',                scope: 'tenant' },
  { method: 'POST',  url: '/mobile-money/campaigns/ref-x/execute',  scope: 'tenant' },
  { method: 'PATCH', url: `/mobile-money/payments/${UUID}/retry`,   scope: 'tenant' },
  // ── IA (calcul pur, hors appels externes) ──
  { method: 'POST', url: '/ai/simulate-its', scope: 'tenant' },
  // ── Plateforme (super_admin) ──
  { method: 'POST',  url: '/platform/tenants',                  scope: 'platform' },
  { method: 'PATCH', url: '/platform/settings',                 scope: 'platform' },
  { method: 'PATCH', url: `/platform/tenants/${UUID}`,          scope: 'platform' },
  { method: 'POST',  url: `/platform/tenants/${UUID}/suspend`,  scope: 'platform' },
  { method: 'POST',  url: `/platform/tenants/${UUID}/reactivate`, scope: 'platform' },
  { method: 'POST',  url: `/platform/tenants/${UUID}/reset-admin`, scope: 'platform' },
  { method: 'POST',  url: '/platform/sourcing/models',          scope: 'platform' },
  { method: 'PATCH', url: `/platform/sourcing/models/${UUID}`,  scope: 'platform' },
  { method: 'POST',  url: '/platform/sourcing/platforms',       scope: 'platform' },
  { method: 'PATCH', url: `/platform/sourcing/platforms/${UUID}`, scope: 'platform' },
  { method: 'PATCH', url: '/platform/sourcing/settings',        scope: 'platform' },
  { method: 'PATCH', url: '/platform/legal-constants/CI/2024',  scope: 'platform' },
  // ── Cabinets de recrutement (super_admin) ──
  { method: 'POST',  url: '/agency/agencies',                   scope: 'platform' },
  { method: 'PATCH', url: `/agency/agencies/${UUID}`,           scope: 'platform' },
  { method: 'POST',  url: `/agency/agencies/${UUID}/suspend`,   scope: 'platform' },
  { method: 'POST',  url: `/agency/agencies/${UUID}/reactivate`, scope: 'platform' },
  { method: 'POST',  url: `/agency/agencies/${UUID}/tenants`,   scope: 'platform' },
  // ── Connectivité (admin tenant) ──
  { method: 'POST',  url: '/integrations/webhooks',             scope: 'tenant' },
  { method: 'POST',  url: '/integrations/api-keys',             scope: 'tenant' },
  { method: 'POST',  url: '/integrations/connectors',           scope: 'tenant' },
  { method: 'PATCH', url: `/integrations/webhooks/${UUID}`,     scope: 'tenant' },
  // ── Cabinets de recrutement (utilisateur cabinet) ──
  { method: 'POST',  url: '/agency/sessions/activate',          scope: 'agency' },
  { method: 'POST',  url: '/agency/sessions/deactivate',        scope: 'agency' },
  { method: 'POST',  url: '/agency/members',                    scope: 'agency' },
  { method: 'PATCH', url: `/agency/members/${UUID}`,            scope: 'agency' },
  { method: 'POST',  url: '/agency/client-tenants',             scope: 'agency' },
]

let app: FastifyInstance

function token(scope: Scope): string {
  const base = {
    sub: UUID, email: 'admin@tenant.test', firstName: 'A', lastName: 'B', employeeId: null,
  }
  if (scope === 'platform') {
    return app.jwt.sign({ ...base, tenantId: null, schemaName: 'platform', role: 'super_admin' })
  }
  if (scope === 'agency') {
    return app.jwt.sign({ ...base, tenantId: null, schemaName: 'platform', role: 'agency_owner',
      actorType: 'agency', agencyId: '11111111-1111-1111-1111-111111111111' })
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
    for (const f of FORMS.filter(x => x.scope === 'tenant' || x.scope === 'platform' || x.scope === 'authed' || x.scope === 'agency')) {
      it(`${f.method} ${f.url}`, async () => {
        const res = await app.inject({
          method: f.method, url: f.url,
          headers: { authorization: `Bearer ${token(f.scope)}` },
          payload: { champ_invalide: ' ', n: Number.NaN },
        })
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
