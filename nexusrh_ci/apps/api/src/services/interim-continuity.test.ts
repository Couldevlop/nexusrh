/**
 * Continuité des validations pendant les congés — le circuit ne s'arrête plus
 * à la porte du valideur absent.
 *
 * Constat du 07/11/2026 : `decideActor` n'ouvrait une étape hiérarchique QUE
 * au responsable concerné, sans aucune échappatoire, et l'étape RH restait
 * bloquée sur le valideur désigné jusqu'à l'ÉCHÉANCE. Un chef de service ou un
 * DRH en congé, et son équipe attendait son retour — sur des demandes de
 * congés, dont l'urgence est précisément la date.
 *
 * Deux sources de continuité, et pas une de plus :
 *   - le suppléant DÉCLARÉ (table `approval_interims`) ;
 *   - l'absence CONSTATÉE (absence approuvée couvrant le jour), qui ouvre
 *     l'étape au niveau SUPÉRIEUR et à l'équipe RH.
 *
 * Et deux garde-fous : jamais un subordonné, jamais sur sa propre demande.
 */
import { describe, it, expect } from 'vitest'
import {
  decideActor, evaluateRequest, parseWorkflowSettings, summarize, trailEntry, type Actor,
} from './approval-workflow.service.js'
import { EMPTY_INTERIM, type InterimContext } from './interim.service.js'

// Hiérarchie : emp → n1 → n2 (n2 sans responsable)
const managerOf = new Map<string, string | null>([
  ['emp', 'n1'], ['n1', 'n2'], ['n2', null], ['rh', null], ['drh', null],
])
const actor = (role: string, employeeId: string | null, userId = `u-${employeeId ?? role}`): Actor =>
  ({ role, employeeId, userId })
const settings = (levels: number, extra: Record<string, unknown> = {}) => parseWorkflowSettings(levels, extra)

function interim(over: Partial<{
  absentEmployeeIds: string[]; absentUserIds: string[]
  standInEmployees: Array<[string, string[]]>; standInUsers: Array<[string, string[]]>
}>): InterimContext {
  return {
    absentEmployeeIds: new Set(over.absentEmployeeIds ?? []),
    absentUserIds:     new Set(over.absentUserIds ?? []),
    standInEmployees:  new Map((over.standInEmployees ?? []).map(([k, v]) => [k, new Set(v)])),
    standInUsers:      new Map((over.standInUsers ?? []).map(([k, v]) => [k, new Set(v)])),
  }
}

const managerStep = { kind: 'manager' as const, level: 1, approverEmployeeId: 'n1' }
const hrStep = { kind: 'hr' as const }
const request = (level = 0) => ({
  employeeId: 'emp', validationLevel: level, status: 'submitted',
  submittedAt: new Date('2026-11-07T08:00:00Z'), trail: [],
})

describe('Rien ne change quand personne n’est absent', () => {
  it('le responsable vise son étape, les autres non', () => {
    expect(decideActor(managerStep, actor('manager', 'n1'), 'emp')).toEqual({ allowed: true, override: false })
    expect(decideActor(managerStep, actor('manager', 'n2'), 'emp'))
      .toEqual({ allowed: false, reason: 'not_your_step' })
    expect(decideActor(managerStep, actor('hr_manager', 'rh'), 'emp'))
      .toEqual({ allowed: false, reason: 'not_your_step' })
  })

  it('aucune mention d’intérim dans la décision ordinaire', () => {
    const d = decideActor(managerStep, actor('manager', 'n1'), 'emp')
    expect(d.allowed && d.interim).toBeUndefined()
  })
})

describe('Suppléant déclaré', () => {
  const ctx = {
    overdue: false, hrValidatorUserId: null,
    interim: interim({ standInEmployees: [['n1', ['sup']]] }),
  }

  it('agit à la place du responsable, et la décision le dit', () => {
    expect(decideActor(managerStep, actor('manager', 'sup'), 'emp', ctx))
      .toEqual({ allowed: true, override: true, interim: { replaced: 'n1', cause: 'declared' } })
  })

  it('n’ouvre rien à qui n’est pas désigné', () => {
    expect(decideActor(managerStep, actor('manager', 'autre'), 'emp', ctx).allowed).toBe(false)
  })

  it('ne vaut que pour le responsable qu’il remplace', () => {
    const autreEtape = { kind: 'manager' as const, level: 1, approverEmployeeId: 'n2' }
    expect(decideActor(autreEtape, actor('manager', 'sup'), 'emp', ctx).allowed).toBe(false)
  })

  it('ne permet pas de valider sa propre demande', () => {
    expect(decideActor(managerStep, actor('manager', 'sup'), 'sup', ctx))
      .toEqual({ allowed: false, reason: 'self' })
  })
})

describe('Responsable absent, sans suppléant déclaré', () => {
  const ctx = (extra: Record<string, unknown> = {}) => ({
    overdue: false, hrValidatorUserId: null,
    interim: interim({ absentEmployeeIds: ['n1'] }),
    upperApprovers: new Set(['n2']),
    ...extra,
  })

  it('le niveau SUPÉRIEUR reprend l’étape', () => {
    expect(decideActor(managerStep, actor('manager', 'n2'), 'emp', ctx()))
      .toEqual({ allowed: true, override: true, interim: { replaced: 'n1', cause: 'absence' } })
  })

  it('l’équipe RH aussi — c’est elle qui termine le circuit de toute façon', () => {
    expect(decideActor(managerStep, actor('hr_manager', 'rh'), 'emp', ctx()).allowed).toBe(true)
    expect(decideActor(managerStep, actor('hr_officer', 'gest'), 'emp', ctx()).allowed).toBe(true)
  })

  it('un collègue sans rôle dans le circuit, non', () => {
    expect(decideActor(managerStep, actor('manager', 'ailleurs'), 'emp', ctx()).allowed).toBe(false)
    expect(decideActor(managerStep, actor('employee', 'copain'), 'emp', ctx()).allowed).toBe(false)
  })

  it('un subordonné du responsable absent, jamais', () => {
    // `upperApprovers` ne contient que les étapes SUIVANTES : 'emp' n'y est pas.
    expect(decideActor(managerStep, actor('manager', 'emp'), 'autre', ctx()).allowed).toBe(false)
  })

  it('rien ne s’ouvre si le responsable n’est pas absent', () => {
    const presentCtx = { overdue: false, hrValidatorUserId: null, upperApprovers: new Set(['n2']) }
    expect(decideActor(managerStep, actor('manager', 'n2'), 'emp', presentCtx).allowed).toBe(false)
  })
})

describe('Étape RH — valideur désigné absent', () => {
  const DESIGNE = 'u-drh'
  const base = { overdue: false, hrValidatorUserId: DESIGNE }

  it('son suppléant déclaré décide à sa place', () => {
    const ctx = { ...base, interim: interim({ standInUsers: [[DESIGNE, ['u-gest']]] }) }
    expect(decideActor(hrStep, actor('hr_officer', 'gest', 'u-gest'), 'emp', ctx))
      .toEqual({ allowed: true, override: true, interim: { replaced: DESIGNE, cause: 'declared' } })
  })

  it('à défaut, l’équipe RH reprend la main SANS attendre l’échéance', () => {
    const ctx = { ...base, interim: interim({ absentUserIds: [DESIGNE] }) }
    const d = decideActor(hrStep, actor('hr_officer', 'gest', 'u-gest'), 'emp', ctx)
    expect(d).toEqual({ allowed: true, override: true, interim: { replaced: DESIGNE, cause: 'absence' } })
  })

  it('présent et dans les délais, il reste le seul à décider', () => {
    expect(decideActor(hrStep, actor('hr_officer', 'gest', 'u-gest'), 'emp', base))
      .toEqual({ allowed: false, reason: 'awaiting_designated' })
  })

  it('l’escalade par échéance dépassée survit, sans mention d’intérim', () => {
    const d = decideActor(hrStep, actor('hr_officer', 'gest', 'u-gest'), 'emp', { ...base, overdue: true })
    expect(d).toEqual({ allowed: true, override: true })
  })

  it('un manager ne décide pas à l’étape RH, même en cas d’absence', () => {
    const ctx = { ...base, interim: interim({ absentUserIds: [DESIGNE] }) }
    expect(decideActor(hrStep, actor('manager', 'n1'), 'emp', ctx).allowed).toBe(false)
  })
})

describe('Circuit complet et traces', () => {
  it('evaluateRequest n’ouvre l’étape qu’au niveau supérieur réellement prévu', () => {
    const ctx = interim({ absentEmployeeIds: ['n1'] })
    // Deux niveaux : n1 absent, n2 est bien une étape suivante → il reprend.
    const deuxNiveaux = evaluateRequest(settings(2), managerOf, request(), actor('manager', 'n2'), ctx)
    expect(deuxNiveaux.decision.allowed).toBe(true)
    // Un seul niveau : n2 n'est PAS dans le circuit → il ne reprend rien,
    // l'équipe RH prend la suite.
    const unNiveau = evaluateRequest(settings(1), managerOf, request(), actor('manager', 'n2'), ctx)
    expect(unNiveau.decision.allowed).toBe(false)
    expect(evaluateRequest(settings(1), managerOf, request(), actor('hr_manager', 'rh'), ctx).decision.allowed).toBe(true)
  })

  it('sans contexte d’intérim, le circuit se comporte comme avant', () => {
    const ev = evaluateRequest(settings(1), managerOf, request(), actor('manager', 'n2'), EMPTY_INTERIM)
    expect(ev.decision.allowed).toBe(false)
  })

  it('le résumé affiché au suppléant lui dit qu’il peut agir, sans être le désigné', () => {
    const ctx = interim({ standInEmployees: [['n1', ['sup']]] })
    const sum = summarize(settings(1), managerOf, request(), actor('manager', 'sup'), ctx)
    expect(sum.canAct).toBe(true)
    // `designated` reste faux : l'écran distingue le valideur de son suppléant.
    expect(sum.designated).toBe(false)
  })

  it('la piste de validation garde qui a été remplacé et pourquoi', () => {
    const entry = trailEntry(0, managerStep, actor('manager', 'sup'), true,
      new Date('2026-11-07T09:00:00Z'), { replaced: 'n1', cause: 'declared' })
    expect(entry).toMatchObject({
      step: 1, kind: 'manager', by: 'u-sup', override: true,
      interim: { replaced: 'n1', cause: 'declared' },
    })
  })

  it('une décision ordinaire ne porte aucune mention d’intérim', () => {
    const entry = trailEntry(0, managerStep, actor('manager', 'n1'), false)
    expect(entry).not.toHaveProperty('interim')
    expect(entry).not.toHaveProperty('override')
  })
})
