import { describe, it, expect } from 'vitest'
import {
  checkNotice, decideActor, DEFAULT_NOTICE, evaluateRequest, hrCanSee, initialValidationLevel,
  managerChain, parseWorkflowSettings, planSteps, stepsFor, summarize, type Actor,
} from './approval-workflow.service.js'

// Hiérarchie : emp → n1 → n2 → n3 (n3 sans responsable)
const managerOf = new Map<string, string | null>([
  ['emp', 'n1'], ['n1', 'n2'], ['n2', 'n3'], ['n3', null], ['rh', null],
])
const settings = (levels: number, extra: Record<string, unknown> = {}) => parseWorkflowSettings(levels, extra)
const actor = (role: string, employeeId: string | null, userId = `u-${employeeId ?? role}`): Actor => ({ role, employeeId, userId })
const HOUR = 3_600_000

describe('chaîne hiérarchique et étapes', () => {
  it('remonte N+1, N+2… jusqu’à la profondeur demandée', () => {
    expect(managerChain('emp', managerOf, 2)).toEqual(['n1', 'n2'])
    expect(managerChain('emp', managerOf, 10)).toEqual(['n1', 'n2', 'n3'])
  })

  it('s’arrête sur un cycle', () => {
    const cyclic = new Map<string, string | null>([['a', 'b'], ['b', 'a']])
    expect(managerChain('a', cyclic, 5)).toEqual(['b'])
  })

  it('les niveaux inexistants sont sautés ; la RH termine toujours', () => {
    expect(planSteps(3, ['n1'])).toEqual([
      { kind: 'manager', level: 1, approverEmployeeId: 'n1' }, { kind: 'hr' },
    ])
    expect(stepsFor(1, managerOf, 'rh')).toEqual([{ kind: 'hr' }])
    expect(stepsFor(3, managerOf, 'emp').map((s) => s.kind)).toEqual(['manager', 'manager', 'manager', 'hr'])
  })

  it('un responsable de la chaîne qui saisit vaut visa jusqu’à son niveau', () => {
    const steps = stepsFor(3, managerOf, 'emp')
    expect(initialValidationLevel(steps, 'n1', 'emp')).toBe(1)
    expect(initialValidationLevel(steps, 'n2', 'emp')).toBe(2)
    expect(initialValidationLevel(steps, 'emp', 'emp')).toBe(0)
    expect(initialValidationLevel(steps, 'rh', 'emp')).toBe(0)
  })
})

describe('droit d’agir', () => {
  const managerStep = { kind: 'manager' as const, level: 1, approverEmployeeId: 'n1' }
  const hrStep = { kind: 'hr' as const }

  it('personne ne valide sa propre demande, même la RH', () => {
    expect(decideActor(hrStep, actor('hr_manager', 'emp'), 'emp')).toEqual({ allowed: false, reason: 'self' })
  })

  it('étape hiérarchique : seul le responsable concerné, jamais la RH (même en retard)', () => {
    expect(decideActor(managerStep, actor('manager', 'n1'), 'emp').allowed).toBe(true)
    expect(decideActor(managerStep, actor('manager', 'n2'), 'emp').allowed).toBe(false)
    expect(decideActor(managerStep, actor('hr_manager', 'rh'), 'emp', { overdue: true, hrValidatorUserId: null }).allowed).toBe(false)
  })

  it('un RH qui est aussi le N+1 vise à ce titre', () => {
    expect(decideActor(managerStep, actor('hr_manager', 'n1'), 'emp')).toEqual({ allowed: true, override: false })
  })

  it('étape RH : valideur désigné, puis toute l’équipe une fois l’échéance dépassée', () => {
    const ctx = { overdue: false, hrValidatorUserId: 'u-drh' }
    expect(decideActor(hrStep, actor('hr_manager', 'drh', 'u-drh'), 'emp', ctx)).toEqual({ allowed: true, override: false })
    expect(decideActor(hrStep, actor('hr_officer', 'gest', 'u-gest'), 'emp', ctx)).toEqual({ allowed: false, reason: 'awaiting_designated' })
    expect(decideActor(hrStep, actor('hr_officer', 'gest', 'u-gest'), 'emp', { ...ctx, overdue: true })).toEqual({ allowed: true, override: true })
    expect(decideActor(hrStep, actor('manager', 'n1'), 'emp', { ...ctx, overdue: true }).allowed).toBe(false)
  })

  it('sans valideur RH désigné : toute l’équipe RH d’emblée', () => {
    expect(decideActor(hrStep, actor('hr_officer', 'gest'), 'emp').allowed).toBe(true)
  })
})

describe('échéances (SLA) et résumé', () => {
  const submittedAt = new Date('2026-10-20T08:00:00Z')

  it('1 jour pour le N+1, puis 2 jours pour la RH à partir du visa', () => {
    const s = settings(1)
    const req = { employeeId: 'emp', validationLevel: 0, status: 'submitted', submittedAt, trail: [] }
    const atN1 = evaluateRequest(s, managerOf, req, actor('manager', 'n1'), new Date(submittedAt.getTime() + 23 * HOUR))
    expect(atN1.overdue).toBe(false)
    expect(atN1.dueAt.toISOString()).toBe('2026-10-21T08:00:00.000Z')

    const visaAt = '2026-10-21T10:00:00.000Z'
    const atHr = evaluateRequest(s, managerOf, {
      ...req, validationLevel: 1,
      trail: [{ step: 1, kind: 'manager', by: 'u-n1', byEmployeeId: 'n1', at: visaAt }],
    }, actor('hr_manager', 'rh'), new Date('2026-10-23T11:00:00Z'))
    expect(atHr.step.kind).toBe('hr')
    expect(atHr.dueAt.toISOString()).toBe('2026-10-23T10:00:00.000Z')
    expect(atHr.overdue).toBe(true)
  })

  it('résumé : étape suivante, échéance, valideur désigné', () => {
    const sum = summarize(settings(2), managerOf,
      { employeeId: 'emp', validationLevel: 1, status: 'submitted', submittedAt, trail: [] },
      actor('manager', 'n2'), submittedAt)
    expect(sum).toMatchObject({ totalSteps: 3, doneSteps: 1, next: { kind: 'manager', level: 2 }, canAct: true, designated: true })
  })

  it('une demande clôturée n’a plus d’étape', () => {
    const sum = summarize(settings(1), managerOf,
      { employeeId: 'emp', validationLevel: 2, status: 'approved', submittedAt }, actor('hr_manager', 'rh'))
    expect(sum.next).toBeNull()
    expect(sum.canAct).toBe(false)
  })
})

describe('visibilité RH', () => {
  const base = { totalSteps: 2, doneSteps: 0, dueAt: null, overdue: false, designated: false }
  const atManager = { ...base, next: { kind: 'manager' as const, level: 1, approverEmployeeId: 'n1' }, canAct: false }
  const atHr = { ...base, next: { kind: 'hr' as const }, canAct: true }

  it('absence : invisible pour la RH tant que les visas hiérarchiques manquent', () => {
    expect(hrCanSee('absences', atManager)).toBe(false)
    expect(hrCanSee('absences', atHr)).toBe(true)
  })

  it('note de frais : visible dès la soumission (lecture seule)', () => {
    expect(hrCanSee('expenses', atManager)).toBe(true)
  })
})

describe('délai de prévenance', () => {
  const today = new Date('2026-10-25T09:00:00Z')

  it('2 à 5 jours : 7 jours avant', () => {
    expect(checkNotice(DEFAULT_NOTICE, 'CP', 3, '2026-10-30', today)).toContain('7 jours')
    expect(checkNotice(DEFAULT_NOTICE, 'CP', 3, '2026-11-01', today)).toBeNull()
  })

  it('au-delà de 5 jours : 1 mois avant', () => {
    expect(checkNotice(DEFAULT_NOTICE, 'CP', 10, '2026-11-10', today)).toContain('30 jours')
    expect(checkNotice(DEFAULT_NOTICE, 'CP', 10, '2026-11-24', today)).toBeNull()
  })

  it('1 jour, maladie, maternité : pas de prévenance', () => {
    expect(checkNotice(DEFAULT_NOTICE, 'CP', 1, '2026-10-26', today)).toBeNull()
    expect(checkNotice(DEFAULT_NOTICE, 'MALADIE', 10, '2026-10-26', today)).toBeNull()
    expect(checkNotice(DEFAULT_NOTICE, 'MATERNITE', 98, '2026-10-26', today)).toBeNull()
  })

  it('désactivable par le tenant', () => {
    expect(checkNotice({ ...DEFAULT_NOTICE, enabled: false }, 'CP', 10, '2026-10-26', today)).toBeNull()
  })
})

describe('paramètres du tenant', () => {
  it('défauts : N+1, SLA 1 j / 2 j, aucun valideur RH désigné', () => {
    expect(parseWorkflowSettings(undefined, null)).toMatchObject({
      levels: 1, managerSlaDays: 1, hrSlaDays: 2, hrValidatorUserId: null,
    })
  })

  it('bornes : niveaux 1–10, valeurs invalides ignorées', () => {
    const s = parseWorkflowSettings(42, { managerSlaDays: 'x', hrSlaDays: 0, notice: { typeCodes: ['CP', 3] } })
    expect(s.levels).toBe(10)
    expect(s.managerSlaDays).toBe(1)
    expect(s.hrSlaDays).toBe(1)
    expect(s.notice.typeCodes).toEqual(['CP'])
  })
})
