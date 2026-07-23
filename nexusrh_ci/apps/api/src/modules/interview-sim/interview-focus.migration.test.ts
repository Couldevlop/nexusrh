import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')

describe('interview_focus — colonnes jsonb migrées lazy (employees + recruitment_jobs)', () => {
  const migrations = read('utils', 'schema-migrations.ts')
  const provisioning = read('db', 'provisioning.ts')

  it('employees.interview_focus ajouté par ensureTenantSchema', () => {
    expect(migrations).toMatch(/ALTER TABLE "\$\{schemaName\}"\.employees ADD COLUMN IF NOT EXISTS interview_focus jsonb/)
  })

  it('recruitment_jobs.interview_focus ajouté par ensureRecruitmentSchemaMigrated', () => {
    expect(provisioning).toMatch(/ALTER TABLE \$\{s\}\.recruitment_jobs ADD COLUMN IF NOT EXISTS interview_focus jsonb/)
  })
})
