import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
const { isSafeOutboundUrlMock } = vi.hoisted(() => ({ isSafeOutboundUrlMock: vi.fn() }))
const { decryptIfPresentMock } = vi.hoisted(() => ({ decryptIfPresentMock: vi.fn(() => null as string | null) }))
const { queueAddMock } = vi.hoisted(() => ({ queueAddMock: vi.fn() }))
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../logger.js', () => ({ logger: loggerMock }))
vi.mock('../redis.js', () => ({ createClient: vi.fn(() => ({})) }))
vi.mock('../utils/ssrf-guard.js', () => ({ isSafeOutboundUrl: isSafeOutboundUrlMock }))
vi.mock('../utils/crypto.js', () => ({ decryptIfPresent: decryptIfPresentMock }))
vi.mock('bullmq', () => ({ Queue: vi.fn(() => ({ add: queueAddMock })) }))

import { processAttendancePollJob } from './attendance-poll.js'

const SCHEMA = 'tenant_sotra'
const DEVICE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function jobFor(data: unknown): Job<unknown, void> {
  return { id: 'job-1', data } as unknown as Job<unknown, void>
}

const BASE_DEVICE_ROW = {
  id: DEVICE_ID,
  base_url: 'https://badgeuse.example.ci/api/punches',
  auth_type: 'none',
  auth_secret_enc: null,
  auth_header_name: null,
  default_headers: {},
  field_mapping: {
    recordsPath: 'data',
    employeePath: 'matricule',
    employeeMatchBy: 'matricule',
    timestampPath: 'ts',
    timestampFormat: 'iso8601',
  },
  sync_cursor: null,
  poll_enabled: true,
  is_active: true,
}

beforeEach(() => {
  queryMock.mockReset()
  isSafeOutboundUrlMock.mockReset()
  isSafeOutboundUrlMock.mockResolvedValue({ ok: true })
  decryptIfPresentMock.mockReset()
  decryptIfPresentMock.mockReturnValue(null)
  queueAddMock.mockReset()
  queueAddMock.mockResolvedValue(undefined)
  loggerMock.info.mockReset()
  loggerMock.error.mockReset()
  loggerMock.warn.mockReset()
  vi.stubGlobal('fetch', vi.fn())
})

describe('processAttendancePollJob — validation du payload', () => {
  it('deviceId non-UUID → rejeté sans crash, aucune requête DB', async () => {
    await expect(
      processAttendancePollJob(jobFor({ schemaName: SCHEMA, deviceId: 'not-a-uuid' })),
    ).resolves.toBeUndefined()
    expect(queryMock).not.toHaveBeenCalled()
    expect(loggerMock.error).toHaveBeenCalled()
  })

  it('schemaName manquant → rejeté sans crash, aucune requête DB', async () => {
    await expect(
      processAttendancePollJob(jobFor({ deviceId: DEVICE_ID })),
    ).resolves.toBeUndefined()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('payload non-objet (null) → rejeté sans crash', async () => {
    await expect(processAttendancePollJob(jobFor(null))).resolves.toBeUndefined()
    expect(queryMock).not.toHaveBeenCalled()
  })
})

describe('processAttendancePollJob — badgeuse absente/inactive', () => {
  it('badgeuse introuvable → skip silencieux, aucun crash', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await expect(
      processAttendancePollJob(jobFor({ schemaName: SCHEMA, deviceId: DEVICE_ID })),
    ).resolves.toBeUndefined()
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('badgeuse inactive → skip, aucun appel réseau', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...BASE_DEVICE_ROW, is_active: false }] })
    await processAttendancePollJob(jobFor({ schemaName: SCHEMA, deviceId: DEVICE_ID }))
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('poll_enabled=false → skip', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...BASE_DEVICE_ROW, poll_enabled: false }] })
    await processAttendancePollJob(jobFor({ schemaName: SCHEMA, deviceId: DEVICE_ID }))
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('processAttendancePollJob — échec réseau (device injoignable)', () => {
  it('fetch qui lève → last_sync_status=error, curseur NON avancé, pas de crash, pas d\'évaluation enfilée', async () => {
    queryMock.mockResolvedValueOnce({ rows: [BASE_DEVICE_ROW] }) // SELECT device
    ;(global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'))
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE statut error

    await expect(
      processAttendancePollJob(jobFor({ schemaName: SCHEMA, deviceId: DEVICE_ID })),
    ).resolves.toBeUndefined()

    expect(queryMock).toHaveBeenCalledTimes(2)
    const updateCall = queryMock.mock.calls[1]!
    expect(String(updateCall[0])).toContain('UPDATE')
    expect(String(updateCall[0])).toContain('attendance_devices')
    expect(String(updateCall[0])).not.toContain('sync_cursor')
    expect(updateCall[1]).toEqual([DEVICE_ID, 'error'])
    expect(queueAddMock).not.toHaveBeenCalled()
  })

  it('URL bloquée par la garde SSRF → error, aucun fetch, curseur non avancé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [BASE_DEVICE_ROW] })
    isSafeOutboundUrlMock.mockResolvedValueOnce({ ok: false, reason: 'Adresse IP privée/interne interdite' })
    queryMock.mockResolvedValueOnce({ rows: [] })

    await expect(
      processAttendancePollJob(jobFor({ schemaName: SCHEMA, deviceId: DEVICE_ID })),
    ).resolves.toBeUndefined()

    expect(global.fetch).not.toHaveBeenCalled()
    const updateCall = queryMock.mock.calls[1]!
    expect(updateCall[1]).toEqual([DEVICE_ID, 'error'])
    expect(queueAddMock).not.toHaveBeenCalled()
  })

  it('HTTP non-2xx → error, curseur non avancé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [BASE_DEVICE_ROW] })
    ;(global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 })
    queryMock.mockResolvedValueOnce({ rows: [] })

    await processAttendancePollJob(jobFor({ schemaName: SCHEMA, deviceId: DEVICE_ID }))

    const updateCall = queryMock.mock.calls[1]!
    expect(updateCall[1]).toEqual([DEVICE_ID, 'error'])
  })
})

describe('processAttendancePollJob — succès', () => {
  it('aucun nouveau pointage → status=ok, curseur inchangé, pas d\'évaluation enfilée', async () => {
    queryMock.mockResolvedValueOnce({ rows: [BASE_DEVICE_ROW] })
    ;(global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, json: async () => ({ data: [] }),
    })
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE ok, sans curseur

    await processAttendancePollJob(jobFor({ schemaName: SCHEMA, deviceId: DEVICE_ID }))

    const updateCall = queryMock.mock.calls[1]!
    expect(String(updateCall[0])).not.toContain('sync_cursor')
    expect(updateCall[1]).toEqual([DEVICE_ID, 'ok'])
    expect(queueAddMock).not.toHaveBeenCalled()
  })

  it('punches insérés → curseur avancé au max punchedAt ISO, status=ok, attendance-evaluate enfilé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [BASE_DEVICE_ROW] }) // SELECT device
    const body = {
      data: [
        { matricule: 'M001', ts: '2026-07-10T08:00:00.000Z' },
        { matricule: 'M002', ts: '2026-07-11T09:30:00.000Z' },
      ],
    }
    ;(global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, json: async () => body,
    })
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] })  // match M001 (résolu)
    queryMock.mockResolvedValueOnce({ rowCount: 1 })              // insert punch 1
    queryMock.mockResolvedValueOnce({ rows: [] })                 // match M002 (non résolu)
    queryMock.mockResolvedValueOnce({ rowCount: 1 })              // insert punch 2
    queryMock.mockResolvedValueOnce({ rows: [] })                 // UPDATE ok + curseur

    await processAttendancePollJob(jobFor({ schemaName: SCHEMA, deviceId: DEVICE_ID }))

    expect(queryMock).toHaveBeenCalledTimes(6)

    const insertCalls = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_punches'))
    expect(insertCalls).toHaveLength(2)
    // employé résolu pour M001
    expect(insertCalls[0]![1]).toEqual(
      expect.arrayContaining(['emp-1']),
    )
    // employé NON résolu pour M002 (employeeId = null)
    expect(insertCalls[1]![1]).toEqual(
      expect.arrayContaining([null]),
    )

    const updateCall = queryMock.mock.calls[5]!
    expect(String(updateCall[0])).toContain('sync_cursor')
    expect(updateCall[1]).toEqual([DEVICE_ID, '2026-07-11T09:30:00.000Z', 'ok'])

    expect(queueAddMock).toHaveBeenCalledTimes(1)
    const [name, payload] = queueAddMock.mock.calls[0]!
    expect(name).toBe('evaluate')
    expect(payload).toEqual({ schemaName: SCHEMA, dateFrom: '2026-07-10', dateTo: '2026-07-11' })

    // observabilité : pointage non résolu journalisé (warn), mais succès global
    expect(loggerMock.warn).toHaveBeenCalled()
  })

  it('la colonne de rapprochement suit un allowlist figé (email) — jamais matchBy interpolé brut', async () => {
    const deviceRow = {
      ...BASE_DEVICE_ROW,
      field_mapping: { ...BASE_DEVICE_ROW.field_mapping, employeeMatchBy: 'email', employeePath: 'email' },
    }
    queryMock.mockResolvedValueOnce({ rows: [deviceRow] })
    ;(global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, json: async () => ({ data: [{ email: 'jean@sotra.ci', ts: '2026-07-12T07:00:00.000Z' }] }),
    })
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'emp-2' }] })
    queryMock.mockResolvedValueOnce({ rowCount: 1 })
    queryMock.mockResolvedValueOnce({ rows: [] })

    await processAttendancePollJob(jobFor({ schemaName: SCHEMA, deviceId: DEVICE_ID }))

    const matchCall = queryMock.mock.calls[1]!
    expect(String(matchCall[0])).toContain('WHERE email = $1')
  })
})
