/**
 * Golden — données de démo : emails ASCII (compatibles z.string().email() de
 * l'API de signature) et libellés français accentués du seed talent.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { asciiEmailPart } from './seed-demo-data.js'

describe('asciiEmailPart', () => {
  it('retire les diacritiques, minuscule, ASCII seul', () => {
    expect(asciiEmailPart('Dème')).toBe('deme')
    expect(asciiEmailPart('Aïcha')).toBe('aicha')
    expect(asciiEmailPart('N’Guessan Éric')).toBe('nguessaneric')
  })
  it('produit un email accepté par z.string().email()', () => {
    const email = `${asciiEmailPart('Serge')}.${asciiEmailPart('Dème')}@email.com`
    expect(email).toBe('serge.deme@email.com')
    expect(z.string().email().safeParse(email).success).toBe(true)
  })
})

describe('seed-talent-lifecycle — accents', () => {
  const src = readFileSync(new URL('./seed-talent-lifecycle.ts', import.meta.url), 'utf-8')
  it('libellés corrigés', () => {
    expect(src).toContain('Baromètre social')
    expect(src).toContain('Directeur des Opérations')
    expect(src).not.toContain('Barometre')
    expect(src).not.toContain('des Operations')
  })
})
