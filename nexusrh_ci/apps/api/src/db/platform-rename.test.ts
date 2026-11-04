import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('./pool.js', () => ({ pool: { query: queryMock } }))

import { platformRenameStatements, NEW_APP_NAME, NEW_SUPPORT_PHONE } from './platform-rename.js'
import { ensurePlatformSchema } from '../utils/schema-migrations.js'

describe('migration renommage platform_settings', () => {
  const [nameSql, phoneSql] = platformRenameStatements() as [string, string]

  it('ne cible que app_name = ancien nom (jamais une valeur personnalisée)', () => {
    expect(nameSql).toMatch(/SET app_name = 'NexusRH'/)
    expect(nameSql).toMatch(/WHERE app_name = 'NexusRH CI'/)
  })

  it('ne cible que l\'ancien numéro, toutes graphies confondues', () => {
    expect(phoneSql).toContain(`SET support_phone = '${NEW_SUPPORT_PHONE}'`)
    expect(phoneSql).toMatch(/regexp_replace\(support_phone, '\[\^0-9\]', '', 'g'\)/)
    expect(phoneSql).toContain("'0709320594'")
    expect(phoneSql).toContain("'2250709320594'")
    expect(NEW_APP_NAME).toBe('NexusRH')
  })

  it('est idempotente : le nouveau libellé et le nouveau numéro ne satisfont aucune clause WHERE', () => {
    expect('NexusRH').not.toBe('NexusRH CI')
    const digits = NEW_SUPPORT_PHONE.replace(/[^0-9]/g, '')
    expect(['0709320594', '2250709320594', '002250709320594']).not.toContain(digits)
  })

  it('est exécutée par ensurePlatformSchema', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    await ensurePlatformSchema()
    const calls = queryMock.mock.calls.map((c) => String(c[0]))
    expect(calls).toContain(nameSql)
    expect(calls).toContain(phoneSql)
    // après les ALTER/INSERT du singleton
    expect(calls.indexOf(nameSql)).toBeGreaterThan(calls.findIndex((s) => s.includes('platform_settings_singleton_idx')))
  })
})
