/**
 * Matricule salarié généré automatiquement — SQL de la séquence, du trigger,
 * de l'index d'unicité et de la reprise (backfill), et leur câblage dans la
 * migration lazy (avant la fiche admin, qui reçoit donc aussi un matricule).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('./pool.js', () => ({ pool: { query: queryMock } }))

import {
  employeeNumberStatements, employeeNumberSetupStatements, employeeNumberBackfillStatement,
  employeeNumberIndexName,
} from './employee-number.js'
import { ensureTenantSchema } from '../utils/schema-migrations.js'

const S = 'tenant_sotra'
const flat = (sqls: string[]) => sqls.map((x) => x.replace(/\s+/g, ' ')).join('\n')

describe('Matricule — DDL (séquence + trigger + unicité)', () => {
  const ddl = flat(employeeNumberSetupStatements(S))

  it('séquence PAR SCHÉMA (concurrence sûre via nextval), idempotente', () => {
    expect(ddl).toContain(`CREATE SEQUENCE IF NOT EXISTS "${S}".employee_number_seq`)
    expect(ddl).toContain(`nextval('"${S}".employee_number_seq')`)
  })

  it('format lisible MAT + 5 chiffres minimum, jamais tronqué au-delà de 99 999', () => {
    expect(ddl).toContain(`'MAT' || lpad(n::text, greatest(5, length(n::text)), '0')`)
  })

  it('saute un matricule déjà saisi à la main (pas de collision générée)', () => {
    expect(ddl).toMatch(/EXIT WHEN NOT EXISTS \(SELECT 1 FROM "tenant_sotra"\.employees WHERE employee_number = candidate\)/)
  })

  it('trigger BEFORE INSERT/UPDATE : saisie conservée (trim), vide → généré, effacement refusé', () => {
    expect(ddl).toContain(`CREATE OR REPLACE TRIGGER employees_assign_number BEFORE INSERT OR UPDATE OF employee_number ON "${S}".employees`)
    expect(ddl).toContain('NEW.employee_number := btrim(NEW.employee_number)')
    expect(ddl).toContain("IF TG_OP = 'UPDATE' AND OLD.employee_number IS NOT NULL")
    expect(ddl).toContain('NEW.employee_number := OLD.employee_number')
    expect(ddl).toContain(`NEW.employee_number := "${S}".next_employee_number()`)
  })

  it('index UNIQUE partiel (fiches non supprimées), doublons historiques tolérés sans casser la migration', () => {
    expect(employeeNumberIndexName(S)).toContain('employee_number') // repéré par describeDbError
    expect(ddl).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "${employeeNumberIndexName(S)}"`)
    expect(ddl).toContain('WHERE employee_number IS NOT NULL AND deleted_at IS NULL')
    expect(ddl).toContain('EXCEPTION WHEN unique_violation')
  })

  it('refuse un nom de schéma invalide (OWASP A03)', () => {
    expect(() => employeeNumberSetupStatements('tenant"; DROP SCHEMA x; --')).toThrow()
    expect(() => employeeNumberBackfillStatement('bad name')).toThrow()
  })
})

describe('Matricule — reprise des fiches existantes (backfill)', () => {
  const bf = employeeNumberBackfillStatement(S).replace(/\s+/g, ' ')

  it("ordre d'ancienneté : date d'embauche puis date de création", () => {
    expect(bf).toContain('ORDER BY hire_date ASC NULLS LAST, created_at ASC, id ASC')
  })

  it('idempotent : ne vise que les matricules NULL/vides, re-vérifié à la mise à jour', () => {
    expect(bf).toContain("WHERE employee_number IS NULL OR btrim(employee_number) = ''")
    expect(bf).toContain("AND (employee_number IS NULL OR btrim(employee_number) = '')")
    expect(bf).toContain(`SET employee_number = "${S}".next_employee_number()`)
  })

  it('le backfill passe APRÈS la création de la fonction et du trigger', () => {
    const all = employeeNumberStatements(S)
    expect(all[all.length - 1]).toBe(employeeNumberBackfillStatement(S))
    expect(all.slice(0, -1)).toEqual(employeeNumberSetupStatements(S))
  })
})

describe('Matricule — câblage dans la migration lazy', () => {
  beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }) })

  it('ensureTenantSchema exécute séquence/trigger/backfill AVANT la création de la fiche admin', async () => {
    await ensureTenantSchema('tenant_matricule_wiring')
    const sqls = queryMock.mock.calls.map((c) => String(c[0]))
    const seqIdx = sqls.findIndex((x) => x.includes('CREATE SEQUENCE IF NOT EXISTS "tenant_matricule_wiring".employee_number_seq'))
    const bfIdx = sqls.findIndex((x) => x.includes('next_employee_number()') && x.includes('ORDER BY hire_date'))
    const adminIdx = sqls.findIndex((x) => x.includes("'Administrateur RH'"))
    expect(seqIdx).toBeGreaterThanOrEqual(0)
    expect(bfIdx).toBeGreaterThan(seqIdx)
    expect(adminIdx).toBeGreaterThan(bfIdx)
  })

  it('une seconde passe sur le même schéma ne rejoue rien (mémoïsation)', async () => {
    await ensureTenantSchema('tenant_matricule_wiring')
    expect(queryMock).not.toHaveBeenCalled()
  })
})