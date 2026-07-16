import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../utils/schema-migrations.ts'), 'utf8')
describe('provisioning attendance', () => {
  for (const t of ['attendance_devices','attendance_punches','attendance_schedules','attendance_days','attendance_warnings','attendance_config']) {
    it(`crée la table ${t} (idempotent)`, () => {
      expect(src).toContain(`CREATE TABLE IF NOT EXISTS "${'${schemaName}'}".${t}`)
    })
  }
  it('unicité pointage (device_id, dedup_key)', () => {
    expect(src).toMatch(/attendance_punches[\s\S]*UNIQUE\s*\(device_id, dedup_key\)/)
  })
})
