import { describe, it, expect } from 'vitest'
import {
  checkMaternityDuration, countAbsenceDays, isMaternityCode, maternityAllowedDays, maternityRule, resolveAbsenceRequest,
} from './absence-duration.service.js'
import { CIV_2024 } from './legislation-packs.js'

const RULE = maternityRule(CIV_2024.leaveRules)!

function fakeDb(routes: Array<[string, unknown[] | Error]>) {
  return {
    async query<R>(sql: string): Promise<{ rows: R[] }> {
      const hit = routes.find(([k]) => sql.includes(k))
      if (!hit) return { rows: [] }
      if (hit[1] instanceof Error) throw hit[1]
      return { rows: hit[1] as R[] }
    },
  }
}

describe('décompte des jours', () => {
  it('jours ouvrables : dimanches et fériés CI exclus', () => {
    // 05/01/2026 (lundi) → 11/01/2026 (dimanche) : 6 jours ouvrables
    expect(countAbsenceDays('2026-01-05', '2026-01-11', 'working_days')).toBe(6)
    // 1er janvier férié
    expect(countAbsenceDays('2026-01-01', '2026-01-03', 'working_days')).toBe(2)
    expect(countAbsenceDays('2026-01-05', '2026-01-11', 'working_days', 5)).toBe(5)
  })
  it('jours calendaires : tous les jours, fériés compris', () => {
    expect(countAbsenceDays('2026-01-01', '2026-01-03', 'calendar_days')).toBe(3)
    // 14 semaines consécutives
    expect(countAbsenceDays('2026-03-02', '2026-06-07', 'calendar_days')).toBe(98)
    expect(countAbsenceDays('2026-03-02', '2026-03-01', 'calendar_days')).toBe(0)
  })
})

describe('maternité — CT CI art. 23.6', () => {
  it('règle du pack CIV', () => {
    expect(RULE).toEqual({
      legalDays: 98, beforeDays: 42, afterDays: 56, multipleBirthDays: 14, illnessDays: 21, maxHospitalizationDays: 365,
    })
    expect(isMaternityCode('MATERNITE')).toBe(true)
    expect(isMaternityCode('CP')).toBe(false)
  })
  it('prolongations cumulables, hospitalisation plafonnée à 12 mois', () => {
    expect(maternityAllowedDays(RULE)).toBe(98)
    expect(maternityAllowedDays(RULE, { multipleBirth: true })).toBe(112)
    expect(maternityAllowedDays(RULE, { multipleBirth: true, illnessExtension: true })).toBe(133)
    expect(maternityAllowedDays(RULE, { childHospitalizedDays: 999 })).toBe(98 + 365)
  })
  it('au-delà du maximum → refus ; plus court → avertissement', () => {
    expect(checkMaternityDuration(98, RULE)).toEqual({ ok: true, allowedDays: 98, legalDays: 98 })
    const over = checkMaternityDuration(112, RULE)
    expect(over.ok).toBe(false)
    expect(over.error).toContain('98 jours')
    expect(checkMaternityDuration(112, RULE, { multipleBirth: true }).ok).toBe(true)
    const short = checkMaternityDuration(70, RULE)
    expect(short.ok).toBe(true)
    expect(short.warning).toContain('8 semaines')
  })
  it('pays sans durée de maternité → pas de règle', () => {
    expect(maternityRule(undefined)).toBeNull()
  })
})

describe('resolveAbsenceRequest', () => {
  it('suit le mode du type (calendaire pour la maladie)', async () => {
    const db = fakeDb([['absence_types', [{ code: 'MALADIE', calculation_mode: 'calendar_days' }]]])
    const r = await resolveAbsenceRequest(db, 'tenant_x', 'e1', 't', '2026-01-05', '2026-01-11')
    expect(r).toMatchObject({ mode: 'calendar_days', days: 7, maternity: null })
  })
  it('maternité : jours calendaires + contrôle de durée du pack', async () => {
    const db = fakeDb([
      ['absence_types', [{ code: 'MATERNITE', calculation_mode: 'working_days' }]],
      ['platform.tenants', [{ id: 't', at_rate: '0.02', has_subsidiaries: false, default_country_code: 'CIV' }]],
    ])
    const r = await resolveAbsenceRequest(db, 'tenant_x', 'e1', 't', '2026-03-02', '2026-06-21')
    expect(r.mode).toBe('calendar_days')
    expect(r.days).toBe(112)
    expect(r.maternity?.ok).toBe(false)
    const ok = await resolveAbsenceRequest(db, 'tenant_x', 'e1', 't', '2026-03-02', '2026-06-21', { multipleBirth: true })
    expect(ok.maternity?.ok).toBe(true)
  })
  it('type illisible → jours ouvrables, sans erreur', async () => {
    const r = await resolveAbsenceRequest(fakeDb([['absence_types', new Error('down')]]), 's', 'e', 't', '2026-01-05', '2026-01-11')
    expect(r).toMatchObject({ mode: 'working_days', days: 6, code: null })
  })
})