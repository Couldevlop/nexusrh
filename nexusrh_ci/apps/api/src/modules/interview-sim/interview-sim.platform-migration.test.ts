import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')

describe('interview_sim — tables platform migrées', () => {
  const migrations = read('utils', 'schema-migrations.ts')
  const provisioning = read('db', 'provisioning.ts')

  it('banque de questions partagée déclarée (boot + provisioning)', () => {
    expect(migrations).toContain('platform.interview_sim_question_banks')
    expect(provisioning).toContain('platform.interview_sim_question_banks')
  })
  it('compteur anonyme agrégé déclaré (boot + provisioning)', () => {
    expect(migrations).toContain('platform.interview_sim_usage')
    expect(provisioning).toContain('platform.interview_sim_usage')
  })
  it('clé métier + langue + jsonb questions présents', () => {
    expect(migrations).toMatch(/role_key\s+varchar/)
    expect(migrations).toMatch(/questions\s+jsonb/)
  })
})
