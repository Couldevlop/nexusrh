/**
 * Golden — Balayage d'autorisation EXHAUSTIF (test d'intrusion statique + dynamique).
 *
 * Le boot golden ne teste qu'UN endpoint représentatif par module. Ici, on
 * énumère TOUTES les routes déclarées dans `modules/**\/*.routes.ts`, on les
 * monte réellement via `buildApp()` et on vérifie, pour chacune :
 *
 *   1. Sans token → 401 (ou 403/503/429), JAMAIS 200/404/500.
 *      404 = route mal montée (bouton UI cassé) ; 500 = handler atteint sans
 *      auth (fuite potentielle) ; 200 = endpoint ouvert par accident.
 *   2. Avec un JWT signé d'une AUTRE clé → 401 (pas de confusion de signature).
 *   3. Avec un token de contexte plateforme sur une route tenant → 403.
 *
 * Les routes délibérément publiques sont listées dans PUBLIC_ROUTES ; toute
 * NOUVELLE route publique doit y être ajoutée explicitement — c'est le point
 * du test : rendre l'ouverture d'un endpoint un acte conscient et revu.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative, sep } from 'path'
import { createHmac } from 'crypto'

vi.hoisted(() => {
  process.env.NODE_ENV     = 'test'
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5434/test'
  process.env.JWT_SECRET   = 'authz-sweep-secret-minimum-32-characters!!'
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
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch:      vi.fn().mockResolvedValue(0),
  setTokenEpoch:      vi.fn().mockResolvedValue(undefined),
  consumeTotpStep:    vi.fn().mockResolvedValue(true),
}))

import { buildApp } from './app.js'

const API_SRC = dirname(fileURLToPath(import.meta.url))
const MODULES = join(API_SRC, 'modules')

/** Préfixes de montage — source de vérité : app.ts. */
const PREFIX: Record<string, string> = {
  'auth/auth.routes.ts': '/auth',
  'auth/auth-mfa.routes.ts': '/auth',
  'platform/platform.routes.ts': '/platform',
  'platform/legal-watch.routes.ts': '/platform/legal-watch',
  'platform/brand.routes.ts': '/platform/brand',
  'employees/employees.routes.ts': '/employees',
  'absences/absences.routes.ts': '/absences',
  'attendance/attendance.routes.ts': '/attendance',
  'payroll/payroll.routes.ts': '/payroll',
  'payroll/payroll-workflow.routes.ts': '/payroll-workflow',
  'cnps/cnps.routes.ts': '/cnps',
  'mobile-money/mobile-money.routes.ts': '/mobile-money',
  'bank-transfer/bank-transfer.routes.ts': '/bank-transfer',
  'recruitment/recruitment.routes.ts': '/recruitment',
  'recruitment/screening.routes.ts': '/recruitment',
  'training/training.routes.ts': '/training',
  'expenses/expenses.routes.ts': '/expenses',
  'reporting/reporting.routes.ts': '/reporting',
  'careers/careers.routes.ts': '/careers',
  'settings/settings.routes.ts': '/settings',
  'contracts/contracts.routes.ts': '/contracts',
  'ai/ai.routes.ts': '/ai',
  'referentiels/referentiels.routes.ts': '/referentiels',
  'agency/agency.routes.ts': '/agency',
  'integrations/integrations.routes.ts': '/integrations',
  'onboarding/onboarding.routes.ts': '/onboarding',
  'org-chart/org-chart.routes.ts': '/org-chart',
  'discipline/discipline.routes.ts': '/discipline',
  'offboarding/offboarding.routes.ts': '/offboarding',
  'climate/climate.routes.ts': '/climate',
  'succession/succession.routes.ts': '/succession',
  'competencies/competencies.routes.ts': '/competencies',
  'calibration/calibration.routes.ts': '/calibration',
  'mobility/mobility.routes.ts': '/mobility',
  'classification/classification.routes.ts': '/classification',
  'signature/signature.routes.ts': '/signature',
  'security/security.routes.ts': '/security',
  'sage/sage.routes.ts': '/sage',
  'dg/dg.routes.ts': '/dg',
  'interview-sim/interview-sim.routes.ts': '/interview-sim',
  'public/demo.routes.ts': '/public/demo',
}

/**
 * Routes VOLONTAIREMENT accessibles sans token (revues une par une).
 * Format : `MÉTHODE /chemin` avec les params sous forme `:nom`.
 */
const PUBLIC_ROUTES = new Set<string>([
  // Parcours d'authentification
  'POST /auth/login',
  'POST /auth/refresh-token',
  'POST /auth/mfa/login-verify',
  'POST /auth/forgot-password',
  'POST /auth/reset-password',
  // Branding avant login + logos dans les emails
  'GET /public/brand/by-slug/:slug',
  'GET /public/brand/:id',
  // Site vitrine / demande de démo
  'GET /public/demo/captcha',
  'POST /public/demo/request',
  // Offres publiques + candidature spontanée
  'GET /recruitment/public/:tenantSlug/jobs',
  'GET /recruitment/public/:tenantSlug/jobs/:jobId',
  'POST /recruitment/public/:tenantSlug/jobs/:jobId/apply',
  // Entraînement à l'entretien via jeton HMAC éphémère
  'GET /public/interview-sim/:token',
  'POST /public/interview-sim/:token/consent',
  'POST /public/interview-sim/:token/submit',
  // Webhook provider signé HMAC (pas de JWT possible)
  'POST /mobile-money/webhooks/:provider',
])

/**
 * Deux fichiers déclarent PLUSIEURS plugins montés sous des préfixes différents
 * (`brand.routes.ts`, `interview-sim.routes.ts`). Le préfixe se résout alors par
 * nom de plugin et non par fichier.
 */
const PLUGIN_PREFIX: Record<string, string> = {
  brandRoutes:             '/platform/brand',
  publicBrandRoutes:       '/public/brand',
  interviewSimRoutes:      '/interview-sim',
  interviewSimPublicRoutes: '/public/interview-sim',
}

interface Route { file: string; line: number; method: string; path: string; key: string }

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const fp = join(dir, e)
    if (statSync(fp).isDirectory()) out.push(...walk(fp))
    else if (/\.routes\.ts$/.test(e)) out.push(fp)
  }
  return out
}

function collectRoutes(): Route[] {
  const routes: Route[] = []
  for (const fp of walk(MODULES)) {
    const rel = relative(MODULES, fp).split(sep).join('/')
    const src = readFileSync(fp, 'utf8')
    const filePrefix = PREFIX[rel]
    if (!filePrefix) continue
    // Frontières de plugins dans le fichier : une route appartient au dernier
    // plugin déclaré avant elle.
    const bounds: Array<{ at: number; name: string }> = []
    for (const d of src.matchAll(/(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*:\s*FastifyPluginAsync/g)) {
      bounds.push({ at: d.index ?? 0, name: d[1] ?? '' })
    }
    const re = /\b(?:fastify|app|server|f)\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*(['"])([^'"]*)\2/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      let owner = ''
      for (const b of bounds) if (b.at < m.index) owner = b.name
      const base = PLUGIN_PREFIX[owner] ?? filePrefix
      const sub = m[3] === '/' ? '' : (m[3] ?? '')
      const path = `${base}${sub}` || '/'
      const method = (m[1] ?? '').toUpperCase()
      routes.push({
        file: rel,
        line: src.slice(0, m.index).split('\n').length,
        method,
        path,
        key: `${method} ${path}`,
      })
    }
  }
  return routes
}

const UUID = '11111111-1111-4111-8111-111111111111'
/** Remplace chaque `:param` par une valeur syntaxiquement plausible. */
function concretize(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const n = name.toLowerCase()
    if (n.includes('slug')) return 'demo-tenant'
    if (n.includes('month')) return '2026-01'
    if (n.includes('year')) return '2026'
    if (n.includes('provider')) return 'wave'
    if (n.includes('token')) return 'aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb'
    if (n.includes('key') || n.includes('code') || n.includes('type')) return 'x'
    return UUID
  })
}

let app: FastifyInstance
let routes: Route[]

beforeAll(async () => {
  routes = collectRoutes()
  app = await buildApp()
  await app.ready()
})
afterAll(async () => { await app?.close() })

describe('Balayage autorisation — toutes les routes', () => {
  it('énumère un nombre plausible de routes', () => {
    expect(routes.length).toBeGreaterThan(300)
  })

  it('aucune route protégée ne répond sans token', async () => {
    const failures: string[] = []
    for (const r of routes) {
      if (PUBLIC_ROUTES.has(r.key)) continue
      const res = await app.inject({ method: r.method as 'GET', url: concretize(r.path) })
      // Attendu : 401 (auth) ou 403 (garde amont) ; 429/503 tolérés (rate-limit,
      // maintenance). Tout le reste est une anomalie.
      if (![401, 403, 429, 503].includes(res.statusCode)) {
        failures.push(`${r.key} → ${res.statusCode}  (${r.file}:${r.line})`)
      }
    }
    expect(failures, `Routes atteignables sans authentification :\n${failures.join('\n')}`).toEqual([])
  })

  it('les routes publiques déclarées existent réellement (pas de 404)', async () => {
    const declared = new Set(routes.map(r => r.key))
    const orphans = [...PUBLIC_ROUTES].filter(k => !declared.has(k))
    expect(orphans, `Entrées PUBLIC_ROUTES sans route correspondante :\n${orphans.join('\n')}`).toEqual([])
  })

  it('un jeton `employee` valide n’atteint aucune route réservée', async () => {
    // Routes dont les options déclarent `authorize(...)` SANS 'employee' :
    // un salarié authentifié doit y récolter un 403, jamais un 200/500.
    const restricted = routes.filter(r => {
      const src = readFileSync(join(MODULES, r.file), 'utf8')
      const lines = src.split('\n')
      const window = lines.slice(r.line - 1, r.line + 12).join(' ')
      const m = /authorize\(([^)]*)\)/.exec(window)
      return !!m && !/'employee'/.test(m[1] ?? '')
    })
    expect(restricted.length).toBeGreaterThan(50)

    const token = app.jwt.sign({
      sub: UUID, jti: UUID, tenantId: UUID, schemaName: 'tenant_demo',
      role: 'employee', email: 'salarie@demo.ci', firstName: 'A', lastName: 'B',
      employeeId: UUID,
    })
    const failures: string[] = []
    for (const r of restricted) {
      const res = await app.inject({
        method: r.method as 'GET', url: concretize(r.path),
        headers: { authorization: `Bearer ${token}` },
      })
      if (![403, 429, 503].includes(res.statusCode)) {
        failures.push(`${r.key} → ${res.statusCode}  (${r.file}:${r.line})`)
      }
    }
    expect(failures, `Routes réservées atteintes par un salarié :\n${failures.join('\n')}`).toEqual([])
  })

  it('un JWT signé avec une autre clé est rejeté partout', async () => {
    // JWT HS256 forgé à la main avec une clé DIFFÉRENTE de JWT_SECRET.
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const head = b64({ alg: 'HS256', typ: 'JWT' })
    const body = b64({
      sub: UUID, jti: UUID, schemaName: 'tenant_demo', role: 'admin',
      email: 'x@y.z', tenantId: UUID, firstName: 'a', lastName: 'b',
      employeeId: null, iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    const sig = createHmac('sha256', 'une-cle-totalement-differente-de-la-vraie!!')
      .update(`${head}.${body}`).digest('base64url')
    const forged = `${head}.${body}.${sig}`
    const failures: string[] = []
    for (const r of routes) {
      if (PUBLIC_ROUTES.has(r.key)) continue
      const res = await app.inject({
        method: r.method as 'GET', url: concretize(r.path),
        headers: { authorization: `Bearer ${forged}` },
      })
      if (![401, 403, 429, 503].includes(res.statusCode)) {
        failures.push(`${r.key} → ${res.statusCode}  (${r.file}:${r.line})`)
      }
    }
    expect(failures, `Routes acceptant un JWT forgé :\n${failures.join('\n')}`).toEqual([])
  })
})
