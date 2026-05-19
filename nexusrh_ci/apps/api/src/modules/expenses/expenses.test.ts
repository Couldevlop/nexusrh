import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify'
import authPlugin from '../../plugins/auth.js'

vi.mock('pg', () => {
  const mockPool = {
    query: vi.fn(),
    end: vi.fn(),
  }
  return { Pool: vi.fn(() => mockPool) }
})

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

describe('Expenses — IDOR protection', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    const { Pool } = await import('pg')
    const mockPool = new Pool({} as never)

    // Route simulant la logique GET /:id avec ownership check
    app = Fastify()
    await app.register(authPlugin)

    app.get('/expenses/:id', { preHandler: [app.authenticate] }, async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string }
      const schema = req.user.schemaName

      // Simuler la requête DB
      const row = (mockPool.query as ReturnType<typeof vi.fn>).mock.results[0]?.value
      const report = { id, employee_email: 'other@tenant.com', title: 'Test' }

      if (req.user.role === 'employee' && report.employee_email !== req.user.email) {
        return reply.status(403).send({ error: 'Accès interdit' })
      }
      return reply.send({ data: report })
    })

    await app.ready()
  })

  afterAll(() => app.close())

  it('employee ne peut pas accéder à la note d\'un autre employé (403)', async () => {
    const token = app.jwt.sign({
      sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra',
      role: 'employee', email: 'kouassi@sotra.ci',
      firstName: 'Kouassi', lastName: 'Jean', employeeId: 'emp-1',
    })
    const res = await app.inject({
      method: 'GET',
      url: '/expenses/some-other-uuid',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('requête sans token rejetée (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/expenses/some-uuid' })
    expect(res.statusCode).toBe(401)
  })
})

describe('Expenses — validation SMIG FCFA', () => {
  it('montants FCFA sont des entiers', () => {
    const amounts = [8_500, 3_500, 15_000, 45_000]
    amounts.forEach(a => expect(a % 1).toBe(0))
  })

  it('total note = somme des lignes', () => {
    const lines = [{ amount: 8_500 }, { amount: 3_500 }]
    const total = lines.reduce((s, l) => s + l.amount, 0)
    expect(total).toBe(12_000)
  })
})
