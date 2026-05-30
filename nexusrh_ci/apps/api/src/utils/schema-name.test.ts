import { describe, it, expect } from 'vitest'
import { isValidSchemaName, assertValidSchemaName, SCHEMA_NAME_RE } from './schema-name.js'

describe('schema-name — whitelist anti-injection (OWASP A03)', () => {
  it('accepte les schémas légitimes', () => {
    for (const ok of ['platform', 'tenant_sotra', 'tenant_cabinet_expertise', 'droit_ci', 'tenant_groupe_ci']) {
      expect(isValidSchemaName(ok), ok).toBe(true)
      expect(() => assertValidSchemaName(ok)).not.toThrow()
    }
  })

  it('rejette les tentatives d\'injection SQL via le nom de schéma', () => {
    const attacks = [
      'tenant_x"; DROP TABLE users--',
      'tenant_x; DROP SCHEMA platform',
      'public", pg_catalog',
      'tenant x',                 // espace
      'TENANT_SOTRA',             // majuscules
      '1tenant',                  // commence par un chiffre
      'tenant-sotra',             // tiret
      "tenant_'",                 // quote
      '',                         // vide
      'a'.repeat(64),             // > 63 caractères
    ]
    for (const bad of attacks) {
      expect(isValidSchemaName(bad), bad).toBe(false)
      expect(() => assertValidSchemaName(bad), bad).toThrow(/invalide/)
    }
  })

  it('rejette les valeurs non-string', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(isValidSchemaName(bad)).toBe(false)
      expect(() => assertValidSchemaName(bad)).toThrow()
    }
  })

  it('borne la longueur à 63 caractères (limite identifiant Postgres)', () => {
    expect(SCHEMA_NAME_RE.test('a'.repeat(63))).toBe(true)
    expect(SCHEMA_NAME_RE.test('a'.repeat(64))).toBe(false)
  })
})
