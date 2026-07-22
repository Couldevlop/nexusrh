import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')

describe('interview_sim — tables tenant provisionnées + migrées lazy', () => {
  const migrations = read('utils', 'schema-migrations.ts')
  const provisioning = read('db', 'provisioning.ts')

  it('historique privé interview_sim_attempts (provisioning + lazy)', () => {
    expect(migrations).toContain('interview_sim_attempts')
    expect(provisioning).toContain('interview_sim_attempts')
  })
  it('config tenant interview_sim_config (provisioning + lazy)', () => {
    expect(migrations).toContain('interview_sim_config')
    expect(provisioning).toContain('interview_sim_config')
  })
  it('attempts liés à employee_id (isolation)', () => {
    expect(migrations).toMatch(/interview_sim_attempts[\s\S]{0,400}employee_id\s+uuid/)
  })
})
