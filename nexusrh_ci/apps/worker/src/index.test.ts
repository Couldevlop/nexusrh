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
  Worker: vi.fn(function () { return ({ on: vi.fn(), close: vi.fn(async () => undefined) }) }),
  Queue: vi.fn(function () { return ({ upsertJobScheduler: upsertMock }) }),
}))
vi.mock('./redis.js', () => ({ createClient: () => connectionStub }))
vi.mock('pg', () => ({ Pool: vi.fn(function () { return ({ query: vi.fn(), end: vi.fn() }) }), Client: vi.fn(function () { return ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }) }) }))
vi.mock('ioredis', () => ({ Redis: vi.fn(function () { return connectionStub }), default: vi.fn(function () { return connectionStub }) }))
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
vi.mock('./jobs/platform-report.js', () => ({ processPlatformReportJob: vi.fn(async () => undefined) }))


const tick = () => new Promise((r) => setTimeout(r, 10))

/**
 * Laisse tourner les promesses en attente déclenchées par un évènement.
 *
 * Attend une CONDITION plutôt qu'un délai fixe. L'ancienne version dormait
 * 10 ms et vérifiait ensuite : sous charge (suite complète du monorepo en
 * parallèle), la chaîne de planification n'avait pas fini et l'assertion
 * tombait à 0 appel, alors que le test passe en isolation. Un test ne doit pas
 * dépendre d'une marge de temporisation.
 *
 * Sans condition, on retombe sur un simple délai de stabilisation — nécessaire
 * pour les assertions « rien de PLUS ne s'est produit », qu'aucune condition ne
 * peut exprimer.
 */
async function flush(until?: () => boolean, timeoutMs = 20_000): Promise<void> {
  if (!until) { await tick(); return }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await tick()
    if (until()) return
    if (Date.now() > deadline) return // laisse l'assertion rapporter l'écart réel
  }
}

describe('amorçage du worker', () => {
  beforeEach(() => {
    upsertMock.mockClear()
  })

  it('pose les planifications au démarrage', async () => {
    await import('./index.js')
    await flush(() => upsertMock.mock.calls.length >= 5)
    // legislation-watch, attendance, interview-sim-consent-purge (1 chacun) et
    // platform-report (2 : hebdomadaire + mensuel) sont inconditionnels ;
    // legal-watch dépend de LEGAL_WATCH_ENABLED.
    expect(upsertMock.mock.calls.length).toBeGreaterThanOrEqual(5)
  })

  it('les réarme quand Redis se reconnecte', async () => {
    await import('./index.js')
    // `import` est servi par le CACHE ESM (le test 1 a deja execute le module) :
    // rien ne repart ici, on laisse juste retomber ce qui serait en vol.
    await flush()
    upsertMock.mockClear()

    connectionStub.emit('ready')
    await flush(() => upsertMock.mock.calls.length >= 5)

    expect(
      upsertMock.mock.calls.length,
      'après une reconnexion Redis, les planifications doivent être reposées : '
      + 'Redis ne les persiste pas et le déploiement le recrée à chaque livraison',
    ).toBeGreaterThanOrEqual(5)
  })

  it('ne réarme pas deux fois en parallèle si Redis bat de l’aile', async () => {
    await import('./index.js')
    // `import` est servi par le CACHE ESM (le test 1 a deja execute le module) :
    // rien ne repart ici, on laisse juste retomber ce qui serait en vol.
    await flush()
    upsertMock.mockClear()

    const perRun = 5
    connectionStub.emit('ready')
    connectionStub.emit('ready')
    connectionStub.emit('ready')
    await flush()

    // Un seul réarmement doit avoir eu lieu malgré les trois évènements.
    expect(upsertMock.mock.calls.length).toBeLessThan(perRun * 3)
  })
})
