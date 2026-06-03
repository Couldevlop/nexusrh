/**
 * Golden Boot Test — démarrage BOUT-À-BOUT de l'API NexusRH CI.
 *
 * Objectif : valider en une passe que l'application réelle (`buildApp()`)
 * démarre intégralement et que CHAQUE module est correctement câblé. C'est le
 * filet de non-régression "boot" : si un module casse à l'enregistrement (import
 * fautif, plugin manquant, route en double, decorator absent…), ce test échoue
 * AVANT le déploiement.
 *
 * Ce que le test prouve :
 *   1. `buildApp()` se résout sans throw → les 19 routeurs + tous les plugins
 *      globaux (cors, swagger, auth, rate-limit, multipart, hooks sécurité,
 *      404/error handlers) s'enregistrent sans conflit.
 *   2. Le health-check répond.
 *   3. CHAQUE préfixe de module est monté ET protégé : un endpoint représentatif
 *      par module, appelé SANS token, renvoie 401 (jamais 404 → la route existe ;
 *      jamais 200/403/500 → l'auth est bien appliquée en amont du handler).
 *   4. Le module auth est monté et reste public (login accessible sans token).
 *   5. Un token invalide est rejeté (401).
 *   6. Le 404 handler et les headers de sécurité OWASP (A05) sont actifs.
 *
 * Stratégie d'isolation : on garde le VRAI `config.ts` (boot authentique) en
 * fournissant les variables d'environnement minimales via `vi.hoisted` (exécuté
 * avant les imports ESM). Seuls `pg` (aucune connexion DB) et le service `redis`
 * (aucune connexion + token jamais blacklisté) sont mockés. Le moteur de paie,
 * les services IA (Anthropic instancié à la volée) et le client Elasticsearch
 * (lazy) ne sont jamais sollicités car les requêtes non authentifiées sont
 * rejetées avant d'atteindre les handlers.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// ── Env minimal AVANT l'import de config.ts ─────────────────────────────────────
// config.ts appelle process.exit(1) si DATABASE_URL / JWT_SECRET (min 32) manquent.
// vi.hoisted s'exécute avant les imports hoistés → l'env est prêt au moment du parse.
vi.hoisted(() => {
  process.env.NODE_ENV     = 'test'
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5434/test'
  process.env.JWT_SECRET   = 'golden-boot-secret-minimum-32-characters!!'
  process.env.LOG_LEVEL    = 'silent'
})

// ── pg : aucune vraie connexion. Toute requête (flag maintenance…) → rows vide ──
const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn().mockResolvedValue({ rows: [] }),
}))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn(), connect: vi.fn() })),
}))

// ── redis : pas de connexion ; aucun token n'est blacklisté ─────────────────────
vi.mock('./services/redis.js', () => ({
  redis:              { quit: vi.fn(), disconnect: vi.fn() },
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

import { buildApp } from './app.js'

// ── Carte : un endpoint protégé représentatif par module ────────────────────────
// (paths vérifiés dans les .routes.ts — chacun porte un preHandler authenticate/authorize)
const PROTECTED_ENDPOINTS: Array<{
  module: string
  method: 'GET' | 'POST'
  url: string
}> = [
  { module: 'platform',         method: 'GET',  url: '/platform/legislation-packs' },
  { module: 'employees',        method: 'GET',  url: '/employees' },
  { module: 'absences',         method: 'GET',  url: '/absences' },
  { module: 'payroll',          method: 'POST', url: '/payroll/calculate' },
  { module: 'payroll-workflow', method: 'POST', url: '/payroll-workflow/periods' },
  { module: 'cnps',             method: 'GET',  url: '/cnps/declarations' },
  { module: 'mobile-money',     method: 'POST', url: '/mobile-money/campaigns' },
  { module: 'recruitment',      method: 'GET',  url: '/recruitment/ai/capabilities' },
  { module: 'training',         method: 'GET',  url: '/training/catalog' },
  { module: 'expenses',         method: 'GET',  url: '/expenses' },
  { module: 'reporting',        method: 'GET',  url: '/reporting/overview' },
  { module: 'careers',          method: 'GET',  url: '/careers/skills' },
  { module: 'settings',         method: 'GET',  url: '/settings/tenant' },
  { module: 'contracts',        method: 'GET',  url: '/contracts' },
  { module: 'ai',               method: 'GET',  url: '/ai/status' },
  // /search porte une validation de querystring (param requis) qui s'exécute
  // AVANT le preHandler → 400. On vise /my-country (auth seule, sans schéma)
  // pour isoler la couche d'authentification.
  { module: 'referentiels',     method: 'GET',  url: '/referentiels/my-country' },
  { module: 'agency',           method: 'GET',  url: '/agency/my-tenants' },
  { module: 'agency',           method: 'POST', url: '/agency/sessions/activate' },
  { module: 'brand',            method: 'POST', url: '/platform/brand/logo' },
  { module: 'integrations',     method: 'GET',  url: '/integrations/webhooks' },
  { module: 'integrations',     method: 'GET',  url: '/integrations/v1/employees' },
]

let app: FastifyInstance

describe('Golden Boot — l\'API NexusRH CI démarre bout-à-bout', () => {
  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('buildApp() démarre sans erreur (tous les routeurs + plugins enregistrés)', () => {
    expect(app).toBeDefined()
    expect(typeof app.inject).toBe('function')
    // Decorators du plugin auth présents → plugin chargé
    expect(typeof app.authenticate).toBe('function')
    expect(typeof app.authorize).toBe('function')
  })

  it('GET /health → 200 { status: "ok" }', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('ok')
    expect(body.service).toBe('nexusrh-ci-api')
  })

  describe('Tous les modules sont montés ET protégés (401 sans token)', () => {
    for (const ep of PROTECTED_ENDPOINTS) {
      it(`${ep.module} — ${ep.method} ${ep.url} → 401 non authentifié`, async () => {
        const res = await app.inject({
          method:  ep.method,
          url:     ep.url,
          payload: ep.method === 'POST' ? {} : undefined,
        })
        // 404 ⇒ module non monté ; 200/403/500 ⇒ auth non câblée en amont du handler.
        expect(
          res.statusCode,
          `${ep.method} ${ep.url} attendu 401, reçu ${res.statusCode}`
        ).toBe(401)
      })
    }
  })

  it('module auth monté et PUBLIC — POST /auth/login sans body → pas 404, validation 400/401/422', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: {} })
    expect(res.statusCode).not.toBe(404)
    expect([400, 401, 422]).toContain(res.statusCode)
  })

  it('token invalide rejeté (401)', async () => {
    const res = await app.inject({
      method:  'GET',
      url:     '/employees',
      headers: { authorization: 'Bearer ceci-nest-pas-un-jwt' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('route inconnue → 404 handler JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/route-qui-nexiste-pas' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toBe('Route introuvable')
  })

  it('headers de sécurité OWASP A05 présents sur toute réponse', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'")
  })
})
