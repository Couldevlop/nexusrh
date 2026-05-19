/**
 * Scénario PME-Test-CI — Décembre 2024
 *
 * Entreprise fictive (5 salariés CNPS) :
 *   - Aïcha Koffi    — cadre Direction        — 1 200 000 FCFA — mariée  0 enf
 *     → congé maternité du lundi 16/12 au mardi 31/12 (14 jours ouvrables)
 *   - Marc Diallo    — cadre Commercial       —   950 000 FCFA — célib.  0 enf
 *   - Sandra Bamba   — cadre Finance          — 1 050 000 FCFA — mariée  2 enf
 *   - Yao Touré      — agent_maîtrise Atelier —   380 000 FCFA — marié   1 enf
 *     → accident du travail du mercredi 11/12 sur 3 semaines (18 j ouvrables en déc.)
 *   - Issa Konaté    — ouvrier Production     —   180 000 FCFA — marié   3 enf
 *
 * Décembre 2024 : 26 jours ouvrables (lun-sam, dimanches exclus — 5 dimanches).
 * Secteur tertiaire/services : taux AT CNPS = 2 %.
 *
 * Ce test fige le comportement attendu pour QA et non-régression future.
 */
import { describe, it, expect } from 'vitest'
import { calculatePayrollCI, type PayrollContext } from './payroll-engine-ci.js'

const DEC_2024_WORKING_DAYS = 26  // lun-sam, dim. 1/8/15/22/29 exclus
const AT_RATE_SERVICES = 0.02

const employees = {
  aicha: {
    name: 'Aïcha Koffi', level: 'cadre', salary: 1_200_000,
    marital: 'married', children: 0,
    workedDays: 12,   // 1-15 déc. = 12 j. ouvrables (dim. 1, 8, 15 exclus)
    absenceDays: 14,  // 16-31 déc. = 14 j. ouvrables (dim. 22, 29 exclus)
  },
  marc:   { name: 'Marc Diallo',   level: 'cadre', salary:   950_000, marital: 'single',  children: 0, workedDays: 26 },
  sandra: { name: 'Sandra Bamba',  level: 'cadre', salary: 1_050_000, marital: 'married', children: 2, workedDays: 26 },
  yao: {
    name: 'Yao Touré', level: 'agent_maitrise', salary: 380_000,
    marital: 'married', children: 1,
    workedDays: 8,     // 1-10 déc. = 8 j. ouvrables (dim. 1, 8 exclus)
    absenceDays: 18,   // 11-31 déc. = 18 j. ouvrables (dim. 15, 22, 29 exclus)
  },
  issa: { name: 'Issa Konaté', level: 'ouvrier', salary: 180_000, marital: 'married', children: 3, workedDays: 26 },
}

function ctx(opts: {
  salary: number; workedDays: number; marital: string; children: number
  absence?: PayrollContext['absence']
}): PayrollContext {
  return {
    baseSalary:       opts.salary,
    workedDays:       opts.workedDays,
    workingDaysMonth: DEC_2024_WORKING_DAYS,
    atRate:           AT_RATE_SERVICES,
    maritalStatus:    opts.marital,
    childrenCount:    opts.children,
    variableElements: {},
    absence:          opts.absence,
  }
}

describe('Scénario PME-Test-CI — Décembre 2024 — Bulletins attendus', () => {

  describe('Bulletin Issa Konaté (ouvrier, mois plein, marié 3 enfants)', () => {
    const r = calculatePayrollCI(ctx({
      salary: employees.issa.salary, workedDays: 26,
      marital: 'married', children: 3,
    }))

    it('mois plein : brut = 180 000 FCFA', () => {
      expect(r.brutProrata).toBe(180_000)
      expect(r.grossSalary).toBe(180_000)
    })

    it('CNPS retraite salarié = 11 340 FCFA (180 000 × 6,3%)', () => {
      expect(r.cnpsRetraiteSal).toBe(11_340)
    })

    it('ITS = 0 grâce au crédit famille (marié + 3 enfants = 14 500 FCFA)', () => {
      expect(r.its).toBe(0)
    })

    it('net à payer = 168 660 FCFA et respect SMIG', () => {
      expect(r.netPayable).toBe(168_660)
      expect(r.smigCompliant).toBe(true)
    })

    it('coût employeur ≈ 199 285 FCFA (charges patronales sur plafond 70 000)', () => {
      // 180 000 brut + 13 860 (retraite pat) + 3 500 (PF) + 525 (mat) + 1 400 (AT 2%)
      expect(r.employerCost).toBe(199_285)
    })

    it('aucun bordereau CNPS (pas d\'absence)', () => {
      expect(r.bordereauCnps).toBeUndefined()
      expect(r.indemniteAbsence).toBeUndefined()
    })
  })

  describe('Bulletin Marc Diallo (cadre célibataire, mois plein 950 000)', () => {
    const r = calculatePayrollCI(ctx({
      salary: employees.marc.salary, workedDays: 26,
      marital: 'single', children: 0,
    }))

    it('CNPS retraite salarié plafonnée à 1 647 315 mais non atteinte (950k)', () => {
      expect(r.cnpsRetraiteSal).toBe(Math.floor(950_000 * 0.063))  // 59 850
    })

    it('ITS > 0 sans crédit familial (passage en tranche 5%)', () => {
      expect(r.its).toBeGreaterThan(20_000)
    })

    it('net à payer cohérent', () => {
      expect(r.netPayable).toBeGreaterThan(700_000)
      expect(r.netPayable).toBeLessThan(950_000)
      expect(r.smigCompliant).toBe(true)
    })
  })

  describe('Bulletin Sandra Bamba (cadre mariée 2 enfants, mois plein 1 050 000)', () => {
    const r = calculatePayrollCI(ctx({
      salary: employees.sandra.salary, workedDays: 26,
      marital: 'married', children: 2,
    }))

    it('crédit impôt = 11 500 FCFA (5 500 marié + 6 000 pour 2 enfants)', () => {
      // Indirect : ITS doit être plus bas que pour un célibataire à même salaire
      const rSingle = calculatePayrollCI(ctx({
        salary: 1_050_000, workedDays: 26, marital: 'single', children: 0,
      }))
      expect(rSingle.its - r.its).toBeGreaterThanOrEqual(11_500)
    })

    it('net à payer cohérent', () => {
      expect(r.netPayable).toBeGreaterThan(800_000)
      expect(r.smigCompliant).toBe(true)
    })
  })

  describe('Bulletin Aïcha Koffi (cadre, congé maternité 16/12 → 31/12)', () => {
    const r = calculatePayrollCI(ctx({
      salary: employees.aicha.salary,
      workedDays: employees.aicha.workedDays,
      marital: 'married', children: 0,
      absence: { type: 'maternite', absenceDays: employees.aicha.absenceDays },
    }))

    it('brutProrata = salaire × 12/26 ≈ 553 846 (présence 12 j.)', () => {
      // 1 200 000 × 12 / 26 = 553 846,15 → floor = 553 846
      expect(r.brutProrata).toBe(553_846)
    })

    it('indemnité maternité = tauxJour × 14 jours ≈ 646 153 FCFA', () => {
      // tauxJour = 1 200 000 / 26 = 46 153,84... × 14 = 646 153,8 → floor
      expect(r.indemniteAbsence).toBe(646_153)
    })

    it('bordereau CNPS généré pour la maternité', () => {
      expect(r.bordereauCnps).toBeDefined()
      expect(r.bordereauCnps?.motif).toBe('maternite')
      expect(r.bordereauCnps?.montant).toBe(646_153)
    })

    it('grossSalary cumule présence + indemnité maternité ≈ 1 200 000', () => {
      expect(r.grossSalary).toBe(553_846 + 646_153)  // = 1 199 999
    })

    it('indemnité maternité EXONÉRÉE d\'ITS (base imposable = présence seule)', () => {
      // Sans maternité, même brutProrata → ITS identique
      const rSansMaternite = calculatePayrollCI(ctx({
        salary: 1_200_000, workedDays: 12, marital: 'married', children: 0,
      }))
      expect(r.its).toBe(rSansMaternite.its)
    })

    it('ligne "1700 Indemnités de congé maternité" présente dans le bulletin', () => {
      const line = r.lines.find(l => l.code === '1700')
      expect(line).toBeDefined()
      expect(line?.amount).toBe(646_153)
    })

    it('net à payer ≥ SMIG (75 000)', () => {
      expect(r.smigCompliant).toBe(true)
    })
  })

  describe('Bulletin Yao Touré (agent maîtrise, AT 11/12 + 3 semaines)', () => {
    const r = calculatePayrollCI(ctx({
      salary: employees.yao.salary,
      workedDays: employees.yao.workedDays,
      marital: 'married', children: 1,
      absence: {
        type: 'accident_travail',
        absenceDays: employees.yao.absenceDays,
        atJourAccidentInMonth: true,
      },
    }))

    it('brutProrata = salaire × 8/26 (présence avant accident)', () => {
      // 380 000 × 8 / 26 = 116 923,08 → floor = 116 923
      expect(r.brutProrata).toBe(116_923)
    })

    it('IJSS CNPS = 17 jours (18 j. absence - 1 jour J payé par employeur)', () => {
      // tauxJour = 380 000 / 26 ≈ 14 615,38 × 17 = 248 461,54 → floor
      expect(r.indemniteAbsence).toBe(248_461)
    })

    it('bordereau CNPS généré pour l\'accident du travail', () => {
      expect(r.bordereauCnps).toBeDefined()
      expect(r.bordereauCnps?.motif).toBe('accident_travail')
      expect(r.bordereauCnps?.montant).toBe(248_461)
    })

    it('IJSS AT EXONÉRÉE d\'ITS (base imposable = présence seule)', () => {
      const rSansAt = calculatePayrollCI(ctx({
        salary: 380_000, workedDays: 8, marital: 'married', children: 1,
      }))
      expect(r.its).toBe(rSansAt.its)
    })

    it('ligne "1900 Indemnité journalière AT (CNPS)" présente', () => {
      const line = r.lines.find(l => l.code === '1900')
      expect(line).toBeDefined()
      expect(line?.amount).toBe(248_461)
    })

    it('net à payer cumule brut présence + IJSS AT', () => {
      expect(r.grossSalary).toBe(116_923 + 248_461)
      expect(r.netPayable).toBe(r.grossSalary - r.totalCnpsSal - r.its)
      expect(r.smigCompliant).toBe(true)
    })
  })

  describe('Synthèse PME-Test — masse salariale + bordereaux CNPS', () => {
    const allResults = {
      issa:   calculatePayrollCI(ctx({ salary: 180_000,   workedDays: 26, marital: 'married', children: 3 })),
      marc:   calculatePayrollCI(ctx({ salary: 950_000,   workedDays: 26, marital: 'single',  children: 0 })),
      sandra: calculatePayrollCI(ctx({ salary: 1_050_000, workedDays: 26, marital: 'married', children: 2 })),
      aicha:  calculatePayrollCI(ctx({
        salary: 1_200_000, workedDays: 12, marital: 'married', children: 0,
        absence: { type: 'maternite', absenceDays: 14 },
      })),
      yao:    calculatePayrollCI(ctx({
        salary: 380_000, workedDays: 8, marital: 'married', children: 1,
        absence: { type: 'accident_travail', absenceDays: 18, atJourAccidentInMonth: true },
      })),
    }

    it('2 bordereaux CNPS générés (Aïcha maternité + Yao AT)', () => {
      const bordereaux = Object.values(allResults)
        .map(r => r.bordereauCnps)
        .filter(b => b !== undefined)
      expect(bordereaux).toHaveLength(2)
      expect(bordereaux.some(b => b!.motif === 'maternite')).toBe(true)
      expect(bordereaux.some(b => b!.motif === 'accident_travail')).toBe(true)
    })

    it('tous les bulletins respectent le SMIG', () => {
      for (const r of Object.values(allResults)) {
        expect(r.smigCompliant).toBe(true)
      }
    })

    it('masse salariale brute totale > 3 700 000 FCFA', () => {
      const total = Object.values(allResults).reduce((s, r) => s + r.grossSalary, 0)
      expect(total).toBeGreaterThan(3_700_000)
    })

    it('aucun montant n\'a de décimale (FCFA entiers)', () => {
      for (const r of Object.values(allResults)) {
        for (const line of r.lines) {
          expect(Number.isInteger(line.amount)).toBe(true)
        }
        expect(Number.isInteger(r.netPayable)).toBe(true)
        expect(Number.isInteger(r.employerCost)).toBe(true)
      }
    })
  })
})
