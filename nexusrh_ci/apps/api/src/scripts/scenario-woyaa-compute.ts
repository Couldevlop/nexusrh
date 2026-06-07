/**
 * Scénario WOYAA — CALCUL SEUL (moteur de paie réel, sans base de données).
 * Donne immédiatement les bulletins + RNS. La persistance dans l'app est
 * faite par scenario-woyaa.ts (nécessite PostgreSQL).
 */
import { calculatePayrollCI, type PayrollContext, type PayrollResult } from '../services/payroll-engine-ci.js'

const AT_RATE = 0.02 // services / conseil
const CP_PAR_MOIS = 2.5

function workingDaysInMonth(y: number, m: number): number {
  const days = new Date(y, m, 0).getDate()
  let n = 0
  for (let d = 1; d <= days; d++) if (new Date(y, m - 1, d).getDay() !== 0) n++
  return n
}
function workingDaysBetween(y: number, m: number, from: number, to: number): number {
  let n = 0
  const dim = new Date(y, m, 0).getDate()
  for (let d = Math.max(1, from); d <= Math.min(to, dim); d++) {
    if (new Date(y, m - 1, d).getDay() !== 0) n++
  }
  return n
}
function grossUp(targetNet: number, maritalStatus: string, childrenCount: number): number {
  const wd = 26
  const netFor = (b: number): number => calculatePayrollCI({
    baseSalary: b, workedDays: wd, workingDaysMonth: wd, atRate: AT_RATE,
    maritalStatus, childrenCount, variableElements: {},
  }).netPayable
  let lo = targetNet, hi = targetNet * 2
  while (netFor(hi) < targetNet) hi *= 2
  for (let i = 0; i < 60; i++) {
    const mid = Math.floor((lo + hi) / 2)
    if (netFor(mid) < targetNet) lo = mid + 1; else hi = mid
  }
  const rounded = Math.round(hi / 1000) * 1000
  if (netFor(rounded) >= targetNet && netFor(rounded) <= targetNet + 1500) return rounded
  return hi
}
const fmt = (n: number): string => n.toLocaleString('fr-FR') + ' FCFA'
function weeklyHours(cat: string): number { return cat === 'Agent de maîtrise' ? 35 : 40 }

interface Emp {
  key: string; name: string; jobTitle: string; category: string
  netTarget: number; hireDate: string; maritalStatus: string; childrenCount: number
  brut?: number; cpPosed?: number
}

const employees: Emp[] = [
  { key: 'ceo', name: 'Konan Yao',     jobTitle: 'Directeur Général (CEO)',          category: 'Cadre supérieur',   netTarget: 1_600_000, hireDate: '2025-02-05', maritalStatus: 'single', childrenCount: 0 },
  { key: 'drh', name: 'Aïcha Touré',   jobTitle: 'Directrice des Ressources Humaines', category: 'Cadre supérieur', netTarget: 1_200_000, hireDate: '2025-03-05', maritalStatus: 'single', childrenCount: 0 },
  { key: 'dc',  name: 'Marc Kouadio',  jobTitle: 'Directeur Commercial',             category: 'Cadre supérieur',   netTarget: 1_000_000, hireDate: '2025-03-05', maritalStatus: 'single', childrenCount: 0 },
  { key: 'rhm', name: 'Fatou Diallo',  jobTitle: 'RH Manager',                       category: 'Cadre',             netTarget: 350_000,   hireDate: '2025-04-05', maritalStatus: 'single', childrenCount: 0 },
  { key: 'com', name: 'Awa Bamba',     jobTitle: 'Chargée commerciale',              category: 'Agent de maîtrise', netTarget: 350_000,   hireDate: '2025-04-05', maritalStatus: 'single', childrenCount: 0 },
  { key: 'sec', name: 'Mariam Koné',   jobTitle: 'Secrétaire de direction',          category: 'Agent de maîtrise', netTarget: 350_000,   hireDate: '2025-04-05', maritalStatus: 'single', childrenCount: 0 },
  { key: 'it',  name: 'Ibrahim Cissé', jobTitle: 'Maintenancier informaticien',      category: 'Agent de maîtrise', netTarget: 350_000,   hireDate: '2025-04-05', maritalStatus: 'single', childrenCount: 0 },
]

const matStart = new Date(2026, 2, 16)
const matEnd = new Date(matStart); matEnd.setDate(matEnd.getDate() + 98 - 1)
const atStart = new Date(2026, 5, 5)
const atEnd = new Date(atStart); atEnd.setDate(atEnd.getDate() + 14 - 1)
const cpAcquisJours = Math.round(11 * CP_PAR_MOIS)
employees.find((e) => e.key === 'sec')!.cpPosed = cpAcquisJours

function congesAsOf(e: Emp, y: number, m: number): { acquired: number; taken: number; remaining: number } {
  const h = new Date(e.hireDate)
  const monthsWorked = (y * 12 + m) - (h.getFullYear() * 12 + (h.getMonth() + 1)) + 1
  const acquired = Math.max(0, Math.round(monthsWorked * CP_PAR_MOIS * 10) / 10)
  let taken = 0
  if (e.key === 'sec' && (y > 2026 || (y === 2026 && m >= 3))) taken = e.cpPosed ?? 0
  return { acquired, taken, remaining: Math.max(0, Math.round((acquired - taken) * 10) / 10) }
}

for (const e of employees) e.brut = grossUp(e.netTarget, e.maritalStatus, e.childrenCount)

function slipFor(e: Emp, y: number, m: number): PayrollResult | null {
  const hire = new Date(e.hireDate)
  if (y < hire.getFullYear() || (y === hire.getFullYear() && m < hire.getMonth() + 1)) return null
  const wdMonth = workingDaysInMonth(y, m)
  const ctx: PayrollContext = {
    baseSalary: e.brut!, workedDays: wdMonth, workingDaysMonth: wdMonth,
    atRate: AT_RATE, maritalStatus: e.maritalStatus, childrenCount: e.childrenCount, variableElements: {},
  }
  if (y === hire.getFullYear() && m === hire.getMonth() + 1) {
    ctx.workedDays = workingDaysBetween(y, m, hire.getDate(), 31)
  }
  if (e.key === 'sec') {
    const monthFirst = new Date(y, m - 1, 1), monthLast = new Date(y, m, 0)
    if (matEnd >= monthFirst && matStart <= monthLast) {
      const from = matStart > monthFirst ? matStart : monthFirst
      const to = matEnd < monthLast ? matEnd : monthLast
      const absWd = workingDaysBetween(y, m, from.getDate(), to.getDate())
      ctx.workedDays = Math.max(0, wdMonth - absWd)
      ctx.absence = { type: 'maternite', absenceDays: absWd }
    }
  }
  if (e.key === 'it' && y === 2026 && m === 6) {
    const absWd = workingDaysBetween(y, m, atStart.getDate(), atEnd.getDate())
    ctx.workedDays = wdMonth - absWd
    ctx.absence = { type: 'accident_travail', absenceDays: absWd, atJourAccidentInMonth: true }
  }
  return calculatePayrollCI(ctx)
}

function printSlip(title: string, e: Emp, y: number, m: number): void {
  const r = slipFor(e, y, m)
  const monthStr = `${y}-${String(m).padStart(2, '0')}`
  if (!r) { console.log(`\n### ${title} : aucun bulletin`); return }
  console.log(`\n──────────────────────────────────────────────────────────────`)
  console.log(`BULLETIN — ${title}`)
  console.log(`${e.name} · ${e.jobTitle} · ${monthStr}`)
  console.log(`Catégorie : ${e.category} · ${weeklyHours(e.category)}h/sem · embauché le ${e.hireDate}`)
  console.log(`Brut mensuel : ${fmt(e.brut!)}  | Jours travaillés : ${r.workingDays}/${workingDaysInMonth(y, m)}`)
  console.log(`──────────────────────────────────────────────────────────────`)
  for (const l of r.lines) {
    const sign = (l.type === 'employee_contribution' || l.type === 'deduction') ? '-' : (l.type.startsWith('employer') ? '~' : '+')
    console.log(`  ${sign} [${l.code}] ${l.label.padEnd(42)} ${fmt(l.amount).padStart(18)}`)
  }
  console.log(`  ─────`)
  console.log(`  Salaire brut .................... ${fmt(r.grossSalary).padStart(18)}`)
  console.log(`  Retenues salariales ............ ${fmt(r.totalDeductions).padStart(18)}  (CNPS ${fmt(r.totalCnpsSal)} + ITS ${fmt(r.its)})`)
  console.log(`  NET À PAYER .................... ${fmt(r.netPayable).padStart(18)}`)
  console.log(`  Coût employeur ................. ${fmt(r.employerCost).padStart(18)}`)
  if (r.indemniteAbsence) console.log(`  Indemnité absence (incluse) .... ${fmt(r.indemniteAbsence).padStart(18)}`)
  if (r.bordereauCnps) console.log(`  → ${r.bordereauCnps.label} : ${fmt(r.bordereauCnps.montant)} (récupérable CNPS)`)
  const cp = congesAsOf(e, y, m)
  console.log(`  Congés payés : acquis ${cp.acquired} j | pris ${cp.taken} j | restant ${cp.remaining} j`)
  if (r.smigCompliant === false) console.log(`  ⚠ Net < SMIG`)
}

console.log('=== WOYAA SARL — conseil stratégique · Abidjan · SARL ===')
console.log('Gross-up (net cible → brut), hypothèse célibataire 0 enfant, AT 2% :')
for (const e of employees) {
  console.log(`  ${e.jobTitle.padEnd(34)} ${weeklyHours(e.category)}h  net ${fmt(e.netTarget).padStart(15)} → brut ${fmt(e.brut!)}`)
}

console.log('\n\n═══════════════ BULLETINS DEMANDÉS ═══════════════')
printSlip('Secrétaire — MARS 2026 (congé maternité dès le 16/03)', employees.find((e) => e.key === 'sec')!, 2026, 3)
printSlip('Informaticien — JUIN 2026 (accident du travail 05/06, 2 sem.)', employees.find((e) => e.key === 'it')!, 2026, 6)
printSlip('CEO — JUIN 2026', employees.find((e) => e.key === 'ceo')!, 2026, 6)
printSlip('DRH — JUIN 2026', employees.find((e) => e.key === 'drh')!, 2026, 6)
printSlip('Directeur commercial — JUIN 2026', employees.find((e) => e.key === 'dc')!, 2026, 6)

console.log('\n\n═══════════════ RNS — cumul janvier→juin 2026 ═══════════════')
console.log('Salarié                         | Brut cumulé      | CNPS sal.      | CNPS pat.      | ITS cumulé     | Net cumulé')
console.log('─'.repeat(116))
for (const e of employees) {
  let brut = 0, cs = 0, cp = 0, its = 0, net = 0
  for (let m = 1; m <= 6; m++) {
    const r = slipFor(e, 2026, m); if (!r) continue
    brut += r.grossSalary; cs += r.totalCnpsSal; cp += r.totalCnpsPat; its += r.its; net += r.netPayable
  }
  console.log(`${e.jobTitle.slice(0, 30).padEnd(31)}| ${fmt(brut).padStart(16)} | ${fmt(cs).padStart(13)} | ${fmt(cp).padStart(13)} | ${fmt(its).padStart(13)} | ${fmt(net).padStart(13)}`)
}
