import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')

describe('interview_sim — table de consentement RGPD (provisionnée + migrée lazy)', () => {
  const migrations = read('utils', 'schema-migrations.ts')
  const provisioning = read('db', 'provisioning.ts')

  it('table interview_sim_consents présente dans les deux chemins', () => {
    expect(migrations).toContain('interview_sim_consents')
    expect(provisioning).toContain('interview_sim_consents')
  })

  it("contrainte CHECK scope IN ('internal','public') dans les deux chemins", () => {
    expect(migrations).toContain(`CHECK (scope IN ('internal','public'))`)
    expect(provisioning).toContain(`CHECK (scope IN ('internal','public'))`)
  })

  it('index sur accepted_at (sert la purge de rétention) dans les deux chemins', () => {
    expect(migrations).toContain('idx_interview_sim_consents_accepted_at')
    expect(provisioning).toContain('idx_interview_sim_consents_accepted_at')
  })

  it('colonne de conservation consent_retention_months (36 mois par défaut) dans les deux chemins', () => {
    expect(migrations).toContain('consent_retention_months int NOT NULL DEFAULT 36')
    expect(provisioning).toContain('consent_retention_months int NOT NULL DEFAULT 36')
  })

  it("non-régression RGPD : interview_sim_attempts n'est jamais recréée", () => {
    expect(migrations).not.toMatch(/CREATE TABLE[\s\S]{0,20}interview_sim_attempts/)
    expect(provisioning).not.toMatch(/CREATE TABLE[\s\S]{0,20}interview_sim_attempts/)
  })
})
