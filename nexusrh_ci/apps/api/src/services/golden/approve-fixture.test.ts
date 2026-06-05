import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoldenFixture } from './golden-fixture.types.js'
import type { PayrollResult } from '../payroll-engine-ci.js'

/**
 * Tests du script CLI `approve-fixture.ts`.
 *
 * Piège : c'est un script à exécution au niveau module (tout le flux tourne dès
 * l'import). On le charge donc DYNAMIQUEMENT après `vi.resetModules()` dans
 * chaque scénario, en ayant au préalable :
 *   - mocké node:fs, node:child_process et le moteur de paie,
 *   - positionné process.argv,
 *   - espionné process.exit (mockImplementation qui throw pour stopper le flux).
 */

const {
  mockReaddirSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockExecSync,
  mockCalculate,
} = vi.hoisted(() => ({
  mockReaddirSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockExecSync: vi.fn(),
  mockCalculate: vi.fn(),
}))

vi.mock('node:fs', () => ({
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
}))

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
}))

vi.mock('../payroll-engine-ci.js', () => ({
  calculatePayrollCI: mockCalculate,
}))

/** Erreur dédiée pour interrompre le flux comme le ferait process.exit(). */
class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
  }
}

/** Construit une fixture golden factice valide et cohérente. */
function makeFixture(overrides: Partial<GoldenFixture> = {}): GoldenFixture {
  return {
    id: '01-test',
    description: 'fixture de test',
    metadata: {
      pack: 'CIV-2024',
      category: 'non-cadre',
      period: '2024-11',
      createdAt: '2024-11-01',
      validatedBy: 'test',
      changelog: [],
    },
    input: {
      baseSalary: 200000,
      workedDays: 26,
      workingDaysMonth: 26,
      atRate: 0.02,
      maritalStatus: 'single',
      childrenCount: 0,
      variableElements: {},
    },
    expected: {
      baseSalary: 200000,
      brutProrata: 200000,
      grossSalary: 200000,
      cnpsRetraiteSal: 12600,
      cnpsRetraitePat: 15400,
      cnpsPfPat: 4025,
      cnpsAtPat: 1400,
      totalCnpsSal: 12600,
      totalCnpsPat: 20825,
      baseImposable: 157400,
      its: 1235,
      totalDeductions: 13835,
      netPayable: 186165,
      employerCost: 220825,
      workingDays: 26,
      smigCompliant: true,
      lines: [{ code: '1000', type: 'earning', amount: 200000 }],
    },
    ...overrides,
  }
}

/** Construit un PayrollResult factice à partir de valeurs « attendues ». */
function makeResult(over: Partial<PayrollResult> = {}): PayrollResult {
  const base: PayrollResult = {
    lines: [
      { code: '1000', label: 'Salaire de base', type: 'earning', base: 200000, amount: 200000 },
    ],
    baseSalary: 200000,
    brutProrata: 200000,
    grossSalary: 200000,
    cnpsRetraiteSal: 12600,
    cnpsRetraitePat: 15400,
    cnpsPfPat: 4025,
    cnpsAtPat: 1400,
    totalCnpsSal: 12600,
    totalCnpsPat: 20825,
    baseImposable: 157400,
    its: 1235,
    totalDeductions: 13835,
    netPayable: 186165,
    employerCost: 220825,
    currency: 'XOF',
    smigCompliant: true,
    workingDays: 26,
  }
  return { ...base, ...over }
}

type AnySpy = { mockRestore: () => void; mock: { calls: unknown[][] } }
let exitSpy: AnySpy
let errSpy: AnySpy
let logSpy: AnySpy
const originalArgv = process.argv

/** Charge le script avec un argv donné ; renvoie le code exit éventuel. */
async function runWith(argv: string[]): Promise<{ exitCode: number | undefined }> {
  process.argv = ['node', 'approve-fixture.ts', ...argv]
  vi.resetModules()
  let exitCode: number | undefined
  try {
    await import('./approve-fixture.js')
  } catch (e) {
    if (e instanceof ExitError) exitCode = e.code
    else throw e
  }
  return { exitCode }
}

beforeEach(() => {
  vi.clearAllMocks()
  exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0)
    }) as never)
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  // Auteur git par défaut : succès
  mockExecSync.mockImplementation((cmd: string) =>
    cmd.includes('user.name') ? 'Jane Dev\n' : 'jane@dev.io\n',
  )
})

afterEach(() => {
  process.argv = originalArgv
  exitSpy.mockRestore()
  errSpy.mockRestore()
  logSpy.mockRestore()
})

describe('approve-fixture — usage / arguments manquants', () => {
  it('affiche usage et exit(1) si aucun argument', async () => {
    const { exitCode } = await runWith([])
    expect(exitCode).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'))
  })

  it('affiche usage et exit(1) si --reason est absent', async () => {
    const { exitCode } = await runWith(['01-test'])
    expect(exitCode).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'))
  })
})

describe('approve-fixture — résolution de la fixture', () => {
  it('exit(1) si aucune fixture ne correspond', async () => {
    mockReaddirSync.mockReturnValue(['99-autre.json'])
    const { exitCode } = await runWith(['introuvable', '--reason', 'motif'])
    expect(exitCode).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Aucune fixture trouvée'))
  })

  it('exit(1) si plusieurs fixtures correspondent', async () => {
    mockReaddirSync.mockReturnValue(['01-test-a.json', '01-test-b.json'])
    const { exitCode } = await runWith(['01-test', '--reason', 'motif'])
    expect(exitCode).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Plusieurs fixtures'))
  })

  it('exit(1) « état inattendu » si l\'unique candidat est falsy', async () => {
    // length === 1 mais l'élément est undefined → branche défensive ligne 50.
    mockReaddirSync.mockReturnValue({
      filter: () => [undefined],
    } as unknown as string[])
    const { exitCode } = await runWith(['01-test', '--reason', 'motif'])
    expect(exitCode).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('État inattendu'))
  })
})

describe('approve-fixture — comparaison et écriture', () => {
  it('exit(0) sans écriture quand aucun changement n\'est détecté', async () => {
    mockReaddirSync.mockReturnValue(['01-test.json'])
    mockReadFileSync.mockReturnValue(JSON.stringify(makeFixture()))
    mockCalculate.mockReturnValue(makeResult())
    const { exitCode } = await runWith(['01-test', '--reason', 'motif'])
    expect(exitCode).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('aucun changement détecté'))
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('détecte les deltas, écrit la fixture mise à jour et journalise le motif', async () => {
    mockReaddirSync.mockReturnValue(['01-test.json'])
    mockReadFileSync.mockReturnValue(JSON.stringify(makeFixture()))
    // Résultat divergent : its change + une ligne supplémentaire
    mockCalculate.mockReturnValue(
      makeResult({
        its: 9999,
        lines: [
          { code: '1000', label: 'Salaire de base', type: 'earning', base: 200000, amount: 200000 },
          { code: '2100', label: 'ITS', type: 'employee_contribution', base: 157400, amount: 9999 },
        ],
      }),
    )
    const { exitCode } = await runWith(['01-test', '--reason', 'Décret 2026-XX'])
    expect(exitCode).toBeUndefined() // pas d'exit : flux jusqu'au bout
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1)

    const [path, content] = mockWriteFileSync.mock.calls[0] as [string, string]
    expect(path).toContain('01-test.json')
    const written = JSON.parse(content) as GoldenFixture
    expect(written.expected.its).toBe(9999)
    expect(written.expected.lines).toHaveLength(2)
    expect(written.metadata.changelog).toHaveLength(1)
    expect(written.metadata.changelog[0]?.reason).toBe('Décret 2026-XX')
    expect(written.metadata.changelog[0]?.author).toBe('Jane Dev <jane@dev.io>')
    expect(written.metadata.changelog[0]?.deltaSummary).toContain('its')
    // Le motif et l'auteur sont aussi affichés
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Motif'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Auteur'))
  })

  it('détecte un changement du nombre de lignes seul', async () => {
    mockReaddirSync.mockReturnValue(['01-test.json'])
    mockReadFileSync.mockReturnValue(JSON.stringify(makeFixture()))
    mockCalculate.mockReturnValue(
      makeResult({
        lines: [
          { code: '1000', label: 'Salaire de base', type: 'earning', base: 200000, amount: 200000 },
          { code: '3000', label: 'CNPS pat', type: 'employer_contribution', base: 200000, amount: 15400 },
        ],
      }),
    )
    const { exitCode } = await runWith(['01-test', '--reason', 'motif'])
    expect(exitCode).toBeUndefined()
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
    const deltaLog = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(deltaLog).toContain('lines count')
  })

  it('sérialise bordereauCnps et indemniteAbsence quand présents dans le résultat', async () => {
    mockReaddirSync.mockReturnValue(['01-test.json'])
    mockReadFileSync.mockReturnValue(JSON.stringify(makeFixture()))
    mockCalculate.mockReturnValue(
      makeResult({
        its: 0,
        indemniteAbsence: 5000,
        bordereauCnps: { motif: 'maternite', montant: 12000, label: 'Indemnité maternité' },
      }),
    )
    await runWith(['01-test', '--reason', 'motif'])
    const [, content] = mockWriteFileSync.mock.calls[0] as [string, string]
    const written = JSON.parse(content) as GoldenFixture
    expect(written.expected.indemniteAbsence).toBe(5000)
    expect(written.expected.bordereauCnps).toEqual({ motif: 'maternite', montant: 12000 })
  })
})

describe('approve-fixture — gitAuthor', () => {
  it('retourne "unknown" si execSync échoue (catch)', async () => {
    mockReaddirSync.mockReturnValue(['01-test.json'])
    mockReadFileSync.mockReturnValue(JSON.stringify(makeFixture()))
    mockCalculate.mockReturnValue(makeResult({ its: 1 }))
    mockExecSync.mockImplementation(() => {
      throw new Error('git absent')
    })
    await runWith(['01-test', '--reason', 'motif'])
    const [, content] = mockWriteFileSync.mock.calls[0] as [string, string]
    const written = JSON.parse(content) as GoldenFixture
    expect(written.metadata.changelog[0]?.author).toBe('unknown')
  })
})
