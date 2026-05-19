#!/usr/bin/env tsx
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { calculatePayrollCI } from '../payroll-engine-ci.js'
import type { GoldenFixture, GoldenFixtureExpectedLine } from './golden-fixture.types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURES_DIR = resolve(__dirname, 'fixtures')

function usage(): never {
  console.error('Usage : pnpm --filter @nexusrhci/api run payroll:fixtures:approve <fixture-id> --reason "<motif>"')
  console.error('Exemple : pnpm --filter @nexusrhci/api run payroll:fixtures:approve 01-employe-celibataire-200k --reason "Décret 2026-XX — plafond CNPS retraite révisé"')
  process.exit(1)
}

function gitAuthor(): string {
  try {
    const name = execSync('git config user.name', { encoding: 'utf8' }).trim()
    const email = execSync('git config user.email', { encoding: 'utf8' }).trim()
    return `${name} <${email}>`
  } catch {
    return 'unknown'
  }
}

const args = process.argv.slice(2)
const fixtureId = args[0]
const reasonIndex = args.indexOf('--reason')
const reason = reasonIndex >= 0 ? args[reasonIndex + 1] : undefined

if (!fixtureId || !reason) usage()

const candidates = readdirSync(FIXTURES_DIR).filter(
  (f) => f.endsWith('.json') && f.includes(fixtureId)
)
if (candidates.length === 0) {
  console.error(`Aucune fixture trouvée pour "${fixtureId}"`)
  process.exit(1)
}
if (candidates.length > 1) {
  console.error(`Plusieurs fixtures correspondent à "${fixtureId}" :`)
  candidates.forEach((c) => console.error(`  - ${c}`))
  process.exit(1)
}

const [candidateFile] = candidates
if (!candidateFile) {
  console.error('État inattendu : aucun fichier candidat')
  process.exit(1)
}
const filePath = resolve(FIXTURES_DIR, candidateFile)
const fixture = JSON.parse(readFileSync(filePath, 'utf8')) as GoldenFixture
const result = calculatePayrollCI(fixture.input)

const newLines: GoldenFixtureExpectedLine[] = result.lines.map((l) => ({
  code: l.code,
  type: l.type,
  amount: l.amount,
}))

const deltas: string[] = []
const fields: Array<keyof typeof fixture.expected> = [
  'baseSalary', 'brutProrata', 'grossSalary',
  'cnpsRetraiteSal', 'cnpsRetraitePat', 'cnpsPfPat', 'cnpsAtPat',
  'totalCnpsSal', 'totalCnpsPat',
  'baseImposable', 'its', 'totalDeductions',
  'netPayable', 'employerCost', 'workingDays', 'smigCompliant',
]
for (const f of fields) {
  const expected = fixture.expected[f]
  const actual = (result as unknown as Record<string, unknown>)[f]
  if (expected !== actual) deltas.push(`${f} ${expected} → ${actual}`)
}
if (result.lines.length !== fixture.expected.lines.length) {
  deltas.push(`lines count ${fixture.expected.lines.length} → ${result.lines.length}`)
}

if (deltas.length === 0) {
  console.log(`Fixture ${fixture.id} : aucun changement détecté, rien à approuver.`)
  process.exit(0)
}

console.log(`Fixture : ${fixture.id}`)
console.log(`Changements détectés :`)
deltas.forEach((d) => console.log(`  • ${d}`))
console.log(`Motif : ${reason}`)
console.log(`Auteur : ${gitAuthor()}`)

const updated: GoldenFixture = {
  ...fixture,
  expected: {
    baseSalary: result.baseSalary,
    brutProrata: result.brutProrata,
    grossSalary: result.grossSalary,
    cnpsRetraiteSal: result.cnpsRetraiteSal,
    cnpsRetraitePat: result.cnpsRetraitePat,
    cnpsPfPat: result.cnpsPfPat,
    cnpsAtPat: result.cnpsAtPat,
    totalCnpsSal: result.totalCnpsSal,
    totalCnpsPat: result.totalCnpsPat,
    baseImposable: result.baseImposable,
    its: result.its,
    totalDeductions: result.totalDeductions,
    netPayable: result.netPayable,
    employerCost: result.employerCost,
    workingDays: result.workingDays,
    smigCompliant: result.smigCompliant,
    indemniteAbsence: result.indemniteAbsence,
    bordereauCnps: result.bordereauCnps
      ? { motif: result.bordereauCnps.motif, montant: result.bordereauCnps.montant }
      : undefined,
    lines: newLines,
  },
  metadata: {
    ...fixture.metadata,
    changelog: [
      ...fixture.metadata.changelog,
      {
        date: new Date().toISOString().slice(0, 10),
        author: gitAuthor(),
        reason,
        deltaSummary: deltas.join(' ; '),
      },
    ],
  },
}

writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n', 'utf8')
console.log(`✓ Fixture mise à jour : ${filePath}`)
console.log(`  Vérifier le diff Git et inclure dans la PR avec le motif documenté.`)
