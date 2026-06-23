import { describe, it, expect } from 'vitest'
import { describeDbError } from './db-error.js'

/** Fabrique une erreur PG-like avec un code et des champs optionnels. */
function pgErr(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error('pg error'), { code, ...extra })
}

describe('describeDbError — traduction erreurs techniques → messages métier', () => {
  it('chiffrement indisponible (ENCRYPTION_UNAVAILABLE) → 503 avec message clair', () => {
    const m = describeDbError(pgErr('ENCRYPTION_UNAVAILABLE', { message: 'clé absente' }))
    expect(m).toEqual({ statusCode: 503, code: 'ENCRYPTION_UNAVAILABLE', error: 'clé absente' })
  })

  it('23505 sur email → 409 message email (via uniqueMessages ou détection email)', () => {
    const viaConstraint = describeDbError(pgErr('23505', { constraint: 'employees_email_key' }), { entity: 'employé' })
    expect(viaConstraint?.statusCode).toBe(409)
    expect(viaConstraint?.error.toLowerCase()).toContain('email')

    const viaOverride = describeDbError(pgErr('23505', { constraint: 'x' }), {
      uniqueMessages: { email: 'Un employé avec cet email existe déjà.' },
      // le détail mentionne email → match override
    })
    expect(viaOverride?.statusCode).toBe(409)
  })

  it('23505 override par champ (matricule)', () => {
    const m = describeDbError(pgErr('23505', { constraint: 'employees_matricule_key' }), {
      uniqueMessages: { matricule: 'Ce matricule est déjà utilisé.' },
    })
    expect(m).toEqual({ statusCode: 409, code: '23505', error: 'Ce matricule est déjà utilisé.' })
  })

  it('23505 générique (ni email ni override) → 409 « existe déjà »', () => {
    const m = describeDbError(pgErr('23505', { constraint: 'autre_unique' }), { entity: 'employé' })
    expect(m?.statusCode).toBe(409)
    expect(m?.error).toContain('existe déjà')
  })

  it('23503 (FK) → 422 référence introuvable', () => {
    const m = describeDbError(pgErr('23503'))
    expect(m?.statusCode).toBe(422)
    expect(m?.error.toLowerCase()).toContain('référence')
  })

  it('23502 (NOT NULL) → 400 et nomme la colonne', () => {
    const m = describeDbError(pgErr('23502', { column: 'last_name' }))
    expect(m?.statusCode).toBe(400)
    expect(m?.error).toContain('last_name')
  })

  it('22P02 (format invalide) → 400', () => {
    expect(describeDbError(pgErr('22P02'))?.statusCode).toBe(400)
  })

  it('22001 (trop long) → 400', () => {
    expect(describeDbError(pgErr('22001'))?.statusCode).toBe(400)
  })

  it('23514 (check) → 422', () => {
    expect(describeDbError(pgErr('23514'))?.statusCode).toBe(422)
  })

  it('42703 / 42P01 (schéma) → 500 message NEUTRE (jamais le SQL brut)', () => {
    for (const code of ['42703', '42P01']) {
      const m = describeDbError(pgErr(code, { message: 'column "xyz" does not exist' }))
      expect(m?.statusCode).toBe(500)
      expect(m?.error).not.toContain('xyz')
      expect(m?.error).not.toContain('does not exist')
    }
  })

  it('erreurs de connexion (08006/53300/57P03) → 503 « service indisponible »', () => {
    for (const code of ['08006', '53300', '57P03']) {
      const m = describeDbError(pgErr(code))
      expect(m?.statusCode).toBe(503)
      expect(m?.error.toLowerCase()).toContain('indisponible')
    }
  })

  it('erreur inconnue (sans code) → null (l\'appelant met un message générique)', () => {
    expect(describeDbError(new Error('boom'))).toBeNull()
    expect(describeDbError(null)).toBeNull()
    expect(describeDbError(pgErr('99999'))).toBeNull()
  })

  it('aucun message renvoyé ne contient « Internal Server Error »', () => {
    const codes = ['ENCRYPTION_UNAVAILABLE', '23505', '23503', '23502', '22P02', '22001', '23514', '42703', '08006']
    for (const code of codes) {
      const m = describeDbError(pgErr(code, { message: 'raw internal' }))
      expect(m?.error).not.toMatch(/internal server error/i)
    }
  })
})
