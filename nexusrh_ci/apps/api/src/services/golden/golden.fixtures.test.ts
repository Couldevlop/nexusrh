import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { calculatePayrollCI } from '../payroll-engine-ci.js'
import type { GoldenFixture } from './golden-fixture.types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURES_DIR = resolve(__dirname, 'fixtures')

const fixtureFiles = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()

describe('PayrollEngineCi — Golden Fixtures (non-régression bloquante, FCFA)', () => {
  if (fixtureFiles.length === 0) {
    it.skip('aucune fixture trouvée dans src/services/golden/fixtures', () => {})
    return
  }

  for (const file of fixtureFiles) {
    const fixture = JSON.parse(
      readFileSync(resolve(FIXTURES_DIR, file), 'utf8')
    ) as GoldenFixture

    describe(`${fixture.id} — ${fixture.description}`, () => {
      const result = calculatePayrollCI(fixture.input)

      it('baseSalary inchangé', () => {
        expect(result.baseSalary).toBe(fixture.expected.baseSalary)
      })

      it('brutProrata exact (entier FCFA)', () => {
        expect(result.brutProrata).toBe(fixture.expected.brutProrata)
      })

      it('grossSalary exact (entier FCFA)', () => {
        expect(result.grossSalary).toBe(fixture.expected.grossSalary)
      })

      it('cnpsRetraiteSal exact', () => {
        expect(result.cnpsRetraiteSal).toBe(fixture.expected.cnpsRetraiteSal)
      })

      it('cnpsRetraitePat exact', () => {
        expect(result.cnpsRetraitePat).toBe(fixture.expected.cnpsRetraitePat)
      })

      it('cnpsPfPat exact (PF + maternité agrégés)', () => {
        expect(result.cnpsPfPat).toBe(fixture.expected.cnpsPfPat)
      })

      it('cnpsAtPat exact', () => {
        expect(result.cnpsAtPat).toBe(fixture.expected.cnpsAtPat)
      })

      it('totalCnpsSal exact', () => {
        expect(result.totalCnpsSal).toBe(fixture.expected.totalCnpsSal)
      })

      it('totalCnpsPat exact', () => {
        expect(result.totalCnpsPat).toBe(fixture.expected.totalCnpsPat)
      })

      it('baseImposable exact', () => {
        expect(result.baseImposable).toBe(fixture.expected.baseImposable)
      })

      it('ITS exact (après crédit famille)', () => {
        expect(result.its).toBe(fixture.expected.its)
      })

      it('totalDeductions exact', () => {
        expect(result.totalDeductions).toBe(fixture.expected.totalDeductions)
      })

      it('netPayable exact', () => {
        expect(result.netPayable).toBe(fixture.expected.netPayable)
      })

      it('employerCost exact', () => {
        expect(result.employerCost).toBe(fixture.expected.employerCost)
      })

      it('workingDays exact', () => {
        expect(result.workingDays).toBe(fixture.expected.workingDays)
      })

      it('smigCompliant correct', () => {
        expect(result.smigCompliant).toBe(fixture.expected.smigCompliant)
      })

      it('currency = XOF', () => {
        expect(result.currency).toBe('XOF')
      })

      if (fixture.expected.indemniteAbsence !== undefined) {
        it('indemniteAbsence exact', () => {
          expect(result.indemniteAbsence).toBe(fixture.expected.indemniteAbsence)
        })
      }

      if (fixture.expected.bordereauCnps) {
        it('bordereauCnps présent avec motif + montant exacts', () => {
          expect(result.bordereauCnps).toBeDefined()
          expect(result.bordereauCnps?.motif).toBe(fixture.expected.bordereauCnps!.motif)
          expect(result.bordereauCnps?.montant).toBe(fixture.expected.bordereauCnps!.montant)
        })
      }

      it(`nombre de lignes (attendu: ${fixture.expected.lines.length})`, () => {
        expect(result.lines).toHaveLength(fixture.expected.lines.length)
      })

      for (const expectedLine of fixture.expected.lines) {
        it(`ligne ${expectedLine.code} — ${expectedLine.type} = ${expectedLine.amount} FCFA`, () => {
          const actualLine = result.lines.find((l) => l.code === expectedLine.code)
          expect(actualLine, `Ligne ${expectedLine.code} absente du résultat`).toBeDefined()
          expect(actualLine!.type).toBe(expectedLine.type)
          expect(actualLine!.amount).toBe(expectedLine.amount)
        })
      }

      it('tous les montants sont des entiers FCFA (zéro décimale)', () => {
        for (const line of result.lines) {
          expect(line.amount % 1).toBe(0)
        }
        expect(result.netPayable % 1).toBe(0)
        expect(result.employerCost % 1).toBe(0)
        expect(result.its % 1).toBe(0)
      })
    })
  }
})
