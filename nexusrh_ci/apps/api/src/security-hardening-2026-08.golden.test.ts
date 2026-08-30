/**
 * Golden — durcissements issus de l'audit d'intrusion du 29/08/2026.
 *
 * Chaque bloc verrouille une vulnérabilité corrigée, en la REJOUANT plutôt qu'en
 * inspectant la configuration : si quelqu'un remet `trustProxy: true`, retire
 * l'épinglage d'algorithme ou réintroduit un évaluateur de code, ces tests
 * échouent.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createHmac } from 'crypto'

vi.hoisted(() => {
  process.env.NODE_ENV     = 'test'
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5434/test'
  process.env.JWT_SECRET   = 'hardening-2026-08-secret-min-32-characters!'
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
}))

import { buildApp } from './app.js'
import { config } from './config.js'
import { evalFormule } from './services/payroll-engine-ci.js'

let app: FastifyInstance
beforeAll(async () => { app = await buildApp(); await app.ready() })
afterAll(async () => { await app?.close() })

// ── S-02 — confiance au proxy bornée ────────────────────────────────────────
describe('S-02 — le rate limiting ne se réinitialise pas via X-Forwarded-For', () => {
  it('trustProxy est borné, jamais `true`', () => {
    // `true` = « faire confiance à tous les intermédiaires » → request.ip suit
    // l'en-tête fourni par le client. C'est exactement la faille corrigée.
    expect(config.trustProxy).not.toBe(true)
    expect(typeof config.trustProxy === 'number' || typeof config.trustProxy === 'string').toBe(true)
    if (typeof config.trustProxy === 'number') {
      expect(config.trustProxy).toBeGreaterThanOrEqual(0)
      expect(config.trustProxy).toBeLessThan(10)
    }
  })

  it('un X-Forwarded-For tournant ne contourne pas la limite du login', async () => {
    // Topologie de production reproduite : l'ingress (adresse PRIVÉE, donc de
    // confiance) ajoute l'IP réelle du client en DERNIÈRE position. L'attaquant
    // ne contrôle que les entrées qui précèdent — et fait tourner la sienne à
    // chaque requête. Avant le correctif, `request.ip` prenait cette entrée
    // fabriquée et le compteur repartait de zéro à chaque appel.
    // LOGIN_RATE_LIMIT = 10 requêtes / 5 minutes.
    let blocked = 0
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({
        method: 'POST', url: '/auth/login',
        headers: { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.42` },
        payload: { email: `a${i}@b.ci`, password: 'x' },
      })
      if (res.statusCode === 429) blocked++
    }
    expect(blocked).toBeGreaterThan(0)
  })

  it('en exposition directe, un X-Forwarded-For forgé est ignoré en bloc', async () => {
    // Une connexion venue d'une adresse PUBLIQUE n'est pas un intermédiaire de
    // confiance : son en-tête ne doit pas être lu du tout. `remoteAddress`
    // simule ici une connexion directe, sans ingress devant.
    // Instance dédiée : la sonde doit être déclarée AVANT `ready()`.
    const probe = await buildApp()
    probe.get('/zz-ip-probe', async (req) => ({ ip: req.ip }))
    await probe.ready()
    try {
      const seen = new Set<string>()
      for (let i = 0; i < 3; i++) {
        const res = await probe.inject({
          method: 'GET', url: '/zz-ip-probe',
          remoteAddress: '198.51.100.9',
          headers: { 'x-forwarded-for': `203.0.113.${i}` },
        })
        if (res.statusCode === 200) seen.add(res.json().ip)
      }
      // Une seule IP vue : celle de la socket, pas les trois valeurs forgées.
      expect([...seen]).toEqual(['198.51.100.9'])
    } finally {
      await probe.close()
    }
  })
})

// ── S-07 — algorithme JWT épinglé ───────────────────────────────────────────
describe('S-07 — algorithme de signature épinglé à HS256', () => {
  const payload = {
    sub: '11111111-1111-4111-8111-111111111111',
    schemaName: 'tenant_demo', role: 'admin', email: 'a@b.ci',
    tenantId: '11111111-1111-4111-8111-111111111111',
    firstName: 'A', lastName: 'B', employeeId: null,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')

  it('les jetons émis sont bien en HS256', () => {
    const token = app.jwt.sign({ ...payload } as never)
    const header = JSON.parse(Buffer.from(token.split('.')[0] as string, 'base64url').toString())
    expect(header.alg).toBe('HS256')
  })

  it('un jeton `alg: none` est rejeté', async () => {
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`
    const res = await app.inject({
      method: 'GET', url: '/employees',
      headers: { authorization: `Bearer ${forged}` },
    })
    expect(res.statusCode).toBe(401)
  })

  it('un jeton HS512 signé avec le VRAI secret est rejeté (confusion d’algorithme)', async () => {
    const head = b64({ alg: 'HS512', typ: 'JWT' })
    const body = b64(payload)
    const sig = createHmac('sha512', process.env.JWT_SECRET as string)
      .update(`${head}.${body}`).digest('base64url')
    const res = await app.inject({
      method: 'GET', url: '/employees',
      headers: { authorization: `Bearer ${head}.${body}.${sig}` },
    })
    expect(res.statusCode).toBe(401)
  })
})

// ── S-06 — évaluateur de formules sans exécution de code ────────────────────
describe('S-06 — évaluateur de formules de paie', () => {
  it('calcule correctement (non-régression arithmétique)', () => {
    expect(evalFormule('100 / 3', {})).toBe(33)
    expect(evalFormule('BASE * 0.063', { BASE: 200_000 })).toBe(12_600)
    expect(evalFormule('(BASE + PRIME) * 2', { BASE: 100, PRIME: 50 })).toBe(300)
    expect(evalFormule('BASE - PRIME * 2', { BASE: 100, PRIME: 20 })).toBe(60)
    expect(evalFormule('-5 + BASE', { BASE: 10 })).toBe(5)
    expect(evalFormule('10 - 50', {})).toBe(0)      // borné à 0
    expect(evalFormule('100 / 0', {})).toBe(0)      // non fini → 0
    expect(evalFormule('VAR:PRIME', { PRIME: 30_000 })).toBe(30_000)
  })

  it('n’exécute aucun code, même sur une entrée conçue pour cela', () => {
    // Toutes ces entrées doivent retomber à 0 sans effet de bord.
    const hostile = [
      'process.exit(1)',
      'CONSTRUCTOR',
      'GLOBALTHIS',
      'JSON',
      'URL',
      'THIS.CONSTRUCTOR',
      '(1)(2)',
      '1,2',
      'BASE',              // identifiant non substitué
      '((((',
      '1..2',
      '',
    ]
    for (const f of hostile) expect(evalFormule(f, {})).toBe(0)
  })

  it('ne laisse aucune trace globale (preuve d’absence d’évaluation)', () => {
    evalFormule('GLOBALTHIS.POLLUTED', {})
    expect((globalThis as Record<string, unknown>).POLLUTED).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
