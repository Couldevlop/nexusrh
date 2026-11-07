/**
 * ensureTenantSchema déclenche la reprise d'office des habilitations — après les
 * migrations de tables, une seule fois par processus et par schéma (mémoïsée).
 * C'est le SEUL chemin de la reprise : jamais le seed.
 */
import { describe, it, expect, vi } from 'vitest'

const { queryMock, bootstrapMock } = vi.hoisted(() => ({
  queryMock: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  bootstrapMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../db/pool.js', () => ({ pool: { query: queryMock, connect: vi.fn() } }))
vi.mock('../db/habilitations-bootstrap.js', () => ({ runHabilitationBootstrap: bootstrapMock }))

import { ensureTenantSchema } from './schema-migrations.js'

describe('ensureTenantSchema → reprise des habilitations', () => {
  it('appelle runHabilitationBootstrap avec le schéma, APRÈS les DDL, une seule fois (mémoïsé)', async () => {
    await ensureTenantSchema('tenant_hab_test')
    expect(bootstrapMock).toHaveBeenCalledTimes(1)
    expect(bootstrapMock).toHaveBeenCalledWith('tenant_hab_test')
    // Les tables d'habilitation sont créées avant la reprise.
    const lastDdl = queryMock.mock.invocationCallOrder[queryMock.mock.invocationCallOrder.length - 1]!
    expect(bootstrapMock.mock.invocationCallOrder[0]!).toBeGreaterThan(lastDdl)
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('"tenant_hab_test".hab_groups'))).toBe(true)
    await ensureTenantSchema('tenant_hab_test')
    expect(bootstrapMock).toHaveBeenCalledTimes(1)
  })

  it('schéma invalide : rejeté avant toute reprise', async () => {
    bootstrapMock.mockClear()
    await expect(ensureTenantSchema('x; DROP')).rejects.toThrow()
    expect(bootstrapMock).not.toHaveBeenCalled()
  })
})
