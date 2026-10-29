/**
 * Fiche employé « à compléter » de l'admin du tenant.
 *
 * Invariants :
 *  - lien par email (insensible à la casse) vers une fiche NON supprimée et
 *    non déjà liée, sinon création d'une fiche salaire 0 puis lien ;
 *  - idempotent : seuls les admins dont employee_id est NULL sont visés ;
 *  - jamais de nom de schéma en dur (validé, interpolé) ;
 *  - la reprise (schema-migrations) exécute les mêmes statements, non scopés.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('./pool.js', () => ({ pool: { query: queryMock } }))

import { adminEmployeeLinkStatements, ensureAdminEmployeeRecord, ADMIN_EMPLOYEE_JOB_TITLE } from './admin-employee.js'
import { ensureTenantSchema } from '../utils/schema-migrations.js'

const norm = (s: string) => s.replace(/\s+/g, ' ')

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('adminEmployeeLinkStatements', () => {
  const stmts = adminEmployeeLinkStatements('tenant_acme').map(norm)
  const link = stmts[0]!
  const create = stmts[1]!

  it('1) lie par email insensible à la casse, fiche non supprimée et non liée', () => {
    expect(link).toContain('UPDATE "tenant_acme".users u SET employee_id = e.id')
    expect(link).toContain("u.role = 'admin'")
    expect(link).toContain('u.employee_id IS NULL')
    expect(link).toContain('e.deleted_at IS NULL')
    expect(link).toContain('lower(e.email) = lower(u.email)')
    expect(link).toContain('NOT EXISTS (SELECT 1 FROM "tenant_acme".users u2 WHERE u2.employee_id = e.id)')
  })

  it('2) crée la fiche « à compléter » (salaire 0, actif, date du jour) seulement sans fiche de même email', () => {
    expect(create).toContain("u.role = 'admin'")
    expect(create).toContain('u.employee_id IS NULL')
    expect(create).toContain('NOT EXISTS (SELECT 1 FROM "tenant_acme".employees e WHERE e.email IS NOT NULL AND lower(e.email) = lower(u.email))')
    expect(create).toContain('INSERT INTO "tenant_acme".employees (user_id, first_name, last_name, email, job_title, hire_date, base_salary, is_active)')
    expect(create).toContain(`'${ADMIN_EMPLOYEE_JOB_TITLE}', CURRENT_DATE, 0, true`)
    expect(create).toContain('ON CONFLICT DO NOTHING')
    // … puis lien explicite users.employee_id
    expect(create).toContain('UPDATE "tenant_acme".users u SET employee_id = ins.id')
  })

  it('le lien précède la création (une fiche existante est réutilisée, jamais dupliquée)', () => {
    expect(link.startsWith('UPDATE')).toBe(true)
    expect(create.startsWith('WITH todo')).toBe(true)
  })

  it('non scopé pour la reprise, scopé à l’email pour la création / réparation', () => {
    expect(link).not.toContain('$1')
    const scoped = adminEmployeeLinkStatements('tenant_acme', true).map(norm)
    for (const sql of scoped) expect(sql).toContain('AND lower(u.email) = lower($1)')
  })

  it('refuse un nom de schéma invalide (OWASP A03)', () => {
    expect(() => adminEmployeeLinkStatements('tenant_x"; DROP SCHEMA public; --')).toThrow()
  })
})

describe('ensureAdminEmployeeRecord', () => {
  it('exécute lien puis création, avec l’email de l’admin en paramètre', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    await ensureAdminEmployeeRecord(db, 'tenant_acme', 'Admin@Acme.ci')
    expect(db.query).toHaveBeenCalledTimes(2)
    expect(norm(String(db.query.mock.calls[0]![0]))).toContain('SET employee_id = e.id')
    expect(norm(String(db.query.mock.calls[1]![0]))).toContain('INSERT INTO "tenant_acme".employees')
    expect(db.query.mock.calls[0]![1]).toEqual(['Admin@Acme.ci'])
    expect(db.query.mock.calls[1]![1]).toEqual(['Admin@Acme.ci'])
  })

  it('propage une erreur SQL (l’appelant décide : atomicité de la création de tenant)', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('boom')) }
    await expect(ensureAdminEmployeeRecord(db, 'tenant_acme', 'a@b.ci')).rejects.toThrow('boom')
  })
})

describe('reprise des tenants existants (ensureTenantSchema)', () => {
  it('exécute le lien par email PUIS la création, après la reprise générique du lien', async () => {
    await ensureTenantSchema('tenant_reprise_admin')
    const sqls = queryMock.mock.calls.map(c => norm(String(c[0])))
    const genericLink = sqls.findIndex(s => s.startsWith('UPDATE "tenant_reprise_admin".users u SET employee_id = e.id FROM') && !s.includes("u.role = 'admin'"))
    const adminLink = sqls.findIndex(s => s.includes("u.role = 'admin'") && s.includes('SET employee_id = e.id'))
    const adminCreate = sqls.findIndex(s => s.includes("u.role = 'admin'") && s.includes('INSERT INTO "tenant_reprise_admin".employees'))
    expect(genericLink).toBeGreaterThanOrEqual(0)
    expect(adminLink).toBeGreaterThan(genericLink)
    expect(adminCreate).toBeGreaterThan(adminLink)
    // Reprise non scopée (tous les admins non liés), sans paramètre
    expect(queryMock.mock.calls[adminCreate]![1]).toBeUndefined()
  })

  it('idempotente : un 2e passage sur le même schéma ne rejoue rien', async () => {
    await ensureTenantSchema('tenant_reprise_idem')
    const first = queryMock.mock.calls.length
    expect(first).toBeGreaterThan(0)
    await ensureTenantSchema('tenant_reprise_idem')
    expect(queryMock.mock.calls.length).toBe(first)
  })

  it('un échec de la reprise n’interrompt pas les migrations (best-effort)', async () => {
    queryMock.mockImplementation((sql: string) =>
      norm(sql).includes("u.role = 'admin'") ? Promise.reject(new Error('x')) : Promise.resolve({ rows: [] }))
    await expect(ensureTenantSchema('tenant_reprise_err')).resolves.toBeUndefined()
  })
})
