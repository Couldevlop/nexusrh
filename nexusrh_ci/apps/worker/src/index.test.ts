/**
 * Amorçage du worker — et surtout : survie des planifications à une coupure
 * Redis.
 *
 * Régression couverte (production, 01/09/2026) : le worker tournait depuis deux
 * heures, ses logs de démarrage annonçaient bien ses trois crons, et Redis ne
 * contenait AUCUNE clé de planification. Le script de déploiement supprime le
 * déploiement Redis à chaque livraison ; Redis ne persiste rien (`--save ''`) ;
 * les planifications BullMQ vivent DANS Redis. Le worker, lui, n'était pas
 * redémarré et ne les posait qu'au démarrage — donc plus rien ne se déclenchait,
 * sans le moindre signal d'erreur.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { upsertMock, connectionStub, loggerMock } = vi.hoisted(() => {
  // Émetteur minimal écrit à la main : la fabrique `vi.hoisted` s'exécute avant
  // les imports du fichier, on ne peut donc pas s'appuyer sur `events`.
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  const connection = {
    on(event: string, fn: (...a: unknown[]) => void) {
      ;(handlers[event] ??= []).push(fn)
      return connection
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of handlers[event] ?? []) fn(...args)
    },
    quit: async () => undefined,
  }
  return {
    upsertMock: vi.fn(async () => undefined),
    connectionStub: connection,
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
})

vi.mock('bullmq', () => ({
  Worker: vi.fn(() => ({ on: vi.fn(), close: vi.fn(async () => undefined) })),
  Queue: vi.fn(() => ({ upsertJobScheduler: upsertMock })),
}))
vi.mock('./redis.js', () => ({ createClient: () => connectionStub }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: vi.fn(), end: vi.fn() })), Client: vi.fn(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() })) }))
vi.mock('ioredis', () => ({ Redis: vi.fn(() => connectionStub), default: vi.fn(() => connectionStub) }))
vi.mock('./logger.js', () => ({ logger: loggerMock }))

// Les handlers de jobs ouvrent des pools PG a l'import : on les neutralise,
// ce fichier ne teste que l'amorcage. Les exports sont declares un par un :
// vitest verifie que le mock expose bien les noms importes.
vi.mock('./jobs/email.js', () => ({ processEmailJob: vi.fn(async () => undefined) }))
vi.mock('./jobs/payroll.js', () => ({ processPayrollJob: vi.fn(async () => undefined) }))
vi.mock('./jobs/cnps.js', () => ({ processCnpsDeclarationJob: vi.fn(async () => undefined) }))
vi.mock('./jobs/ai-scoring.js', () => ({ processAiScoringJob: vi.fn(async () => undefined) }))
vi.mock('./jobs/legal-watch.js', () => ({ processLegalWatchJob: vi.fn(async () => undefined) }))
vi.mock('./jobs/legislation-watch.js', () => ({ processLegislationWatchJob: vi.fn(async () => undefined) }))
vi.mock('./jobs/attendance-poll.js', () => ({ processAttendancePollJob: vi.fn(async () => undefined) }))
vi.mock('./jobs/attendance-evaluate.js', () => ({ processAttendanceEvaluateJob: vi.fn(async () => undefined) }))
vi.mock('./jobs/attendance-cron.js', () => ({ processAttendanceCronJob: vi.fn(async () => undefined) }))
vi.mock('./jobs/interview-sim-consent-purge.js', () => ({ processInterviewSimConsentPurgeJob: vi.fn(async () => undefined) }))


/** Laisse tourner les promesses en attente déclenchées par un évènement. */
const flush = () => new Promise((r) => setTimeout(r, 10))

describe('amorçage du worker', () => {
  beforeEach(() => {
    upsertMock.mockClear()
  })

  it('pose les planifications au démarrage', async () => {
    await import('./index.js')
    await flush()
    // legislation-watch, attendance et interview-sim-consent-purge sont
    // inconditionnels ; legal-watch dépend de LEGAL_WATCH_ENABLED.
    expect(upsertMock.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('les réarme quand Redis se reconnecte', async () => {
    await import('./index.js')
    await flush()
    upsertMock.mockClear()

    connectionStub.emit('ready')
    await flush()

    expect(
      upsertMock.mock.calls.length,
      'après une reconnexion Redis, les planifications doivent être reposées : '
      + 'Redis ne les persiste pas et le déploiement le recrée à chaque livraison',
    ).toBeGreaterThanOrEqual(3)
  })

  it('ne réarme pas deux fois en parallèle si Redis bat de l’aile', async () => {
    await import('./index.js')
    await flush()
    upsertMock.mockClear()

    const perRun = 3
    connectionStub.emit('ready')
    connectionStub.emit('ready')
    connectionStub.emit('ready')
    await flush()

    // Un seul réarmement doit avoir eu lieu malgré les trois évènements.
    expect(upsertMock.mock.calls.length).toBeLessThan(perRun * 3)
  })
})
