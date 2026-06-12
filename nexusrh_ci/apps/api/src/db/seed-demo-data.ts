/**
 * Seed — enrichissement « zéro écran vide » (données d'activité de démo).
 *
 * Chaque visualisation de l'application (graphes, tableaux, kanbans, KPI,
 * barres de progression) doit être remplie pour TOUS les utilisateurs seedés.
 * Ces générateurs sont génériques : ils s'appliquent à n'importe quel schéma
 * tenant et travaillent en dates RELATIVES à aujourd'hui pour que la démo
 * reste actuelle quel que soit le jour du déploiement.
 *
 * Règles : FCFA entiers, soldes cohérents (acquired ≥ taken + pending),
 * statuts variés sur chaque workflow pour illustrer tous les badges.
 */
import type { Pool } from 'pg'

// ── Helpers ───────────────────────────────────────────────────────────────────
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randItem<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T
}

/** Mois 'YYYY-MM' décalé de `offset` mois dans le passé (0 = mois courant). */
export function monthOffsetStr(offset: number): string {
  const d = new Date()
  d.setDate(1) // évite les débordements en fin de mois (31 → mois suivant)
  d.setMonth(d.getMonth() - offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Les n derniers mois révolus, du plus ancien au plus récent (hors mois courant). */
export function lastClosedMonths(n: number): string[] {
  const months: string[] = []
  for (let i = n; i >= 1; i--) months.push(monthOffsetStr(i))
  return months
}

/** Date 'YYYY-MM-DD' décalée de `days` jours (négatif = passé). */
export function dateOffsetStr(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── Absences en masse ─────────────────────────────────────────────────────────
/**
 * Historique d'absences sur les 11 derniers mois pour la majorité des employés :
 * mix de statuts (approved / pending / rejected), plusieurs demandes en attente
 * (badge « à valider » côté manager/RH) et 3-4 absences couvrant AUJOURD'HUI
 * (widget « Absences aujourd'hui » du dashboard).
 */
export async function seedAbsencesBulk(
  pool: Pool,
  schema: string,
  employeeIds: string[],
  absTypeMap: Record<string, string>,
): Promise<number> {
  const cpId = absTypeMap['CP']
  if (!cpId) return 0
  const maladieId = absTypeMap['MALADIE'] ?? cpId
  const deuilId = absTypeMap['DEUIL'] ?? cpId

  let inserted = 0
  const insert = async (
    employeeId: string, typeId: string, startOffset: number, days: number,
    status: 'approved' | 'pending' | 'rejected', reason: string,
  ): Promise<void> => {
    try {
      // NB : ne jamais réutiliser le même paramètre comme colonne varchar ET
      // dans une comparaison texte (42P08 « inconsistent types ») → $8 booléen.
      await pool.query(
        `INSERT INTO "${schema}".absences
           (employee_id, absence_type_id, start_date, end_date, days, half_day,
            reason, status, approved_at)
         VALUES ($1,$2,$3,$4,$5,false,$6,$7, CASE WHEN $8 THEN now() ELSE NULL END)
         ON CONFLICT DO NOTHING`,
        [employeeId, typeId, dateOffsetStr(startOffset),
         dateOffsetStr(startOffset + days - 1), days, reason, status,
         status === 'approved'],
      )
      inserted++
    } catch { /* table sans colonne optionnelle : non bloquant */ }
  }

  for (let i = 0; i < employeeIds.length; i++) {
    const id = employeeIds[i]!
    // 80 % des employés ont au moins un congé approuvé dans l'année écoulée
    if (i % 5 !== 4) {
      await insert(id, cpId, -(20 + ((i * 17) % 280)), randInt(2, 5), 'approved', 'Congés annuels')
    }
    // 1/3 : un arrêt maladie court approuvé
    if (i % 3 === 0) {
      await insert(id, maladieId, -(10 + ((i * 11) % 180)), randInt(1, 2), 'approved', 'Arrêt maladie')
    }
    // 1/8 : une demande EN ATTENTE (à valider par le manager / la RH)
    if (i % 8 === 2) {
      await insert(id, cpId, 3 + (i % 12), randInt(1, 3), 'pending', 'Convenance personnelle')
    }
    // 1/10 : une demande refusée (badge rouge)
    if (i % 10 === 6) {
      await insert(id, cpId, -(5 + (i % 40)), randInt(1, 2), 'rejected', 'Période de forte activité')
    }
    // 1/14 : un deuil familial approuvé
    if (i % 14 === 7) {
      await insert(id, deuilId, -(30 + (i % 90)), 3, 'approved', 'Deuil familial')
    }
  }

  // 3-4 absences couvrant AUJOURD'HUI → le KPI « Absences aujourd'hui » est non nul
  const todayIdx = [1, 4, 7, 10].filter((n) => n < employeeIds.length)
  for (const n of todayIdx) {
    await insert(employeeIds[n]!, n % 2 === 0 ? cpId : maladieId, -1, 3, 'approved',
      n % 2 === 0 ? 'Congés en cours' : 'Arrêt maladie en cours')
  }
  return inserted
}

/**
 * Recalcule les soldes (taken / pending / remaining) de l'année courante à
 * partir des absences réellement insérées — garantit acquired ≥ taken + pending.
 */
export async function recomputeAbsenceBalances(pool: Pool, schema: string): Promise<void> {
  try {
    await pool.query(`
      UPDATE "${schema}".absence_balances b
         SET taken     = LEAST(COALESCE(ag.taken, 0), b.acquired),
             pending   = COALESCE(ag.pending, 0),
             remaining = GREATEST(b.acquired - LEAST(COALESCE(ag.taken,0), b.acquired) - COALESCE(ag.pending,0), 0),
             updated_at = now()
        FROM (
          SELECT employee_id, absence_type_id,
                 SUM(days) FILTER (WHERE status = 'approved') AS taken,
                 SUM(days) FILTER (WHERE status = 'pending')  AS pending
            FROM "${schema}".absences
           WHERE EXTRACT(YEAR FROM start_date) = EXTRACT(YEAR FROM now())
           GROUP BY employee_id, absence_type_id
        ) ag
       WHERE ag.employee_id = b.employee_id
         AND ag.absence_type_id = b.absence_type_id
         AND b.year = EXTRACT(YEAR FROM now())::int
    `)
  } catch { /* non bloquant */ }
}

// ── Notes de frais en masse ───────────────────────────────────────────────────
const EXPENSE_TEMPLATES: ReadonlyArray<{
  title: string
  lines: ReadonlyArray<{ description: string; category: string; amount: number }>
}> = [
  { title: 'Mission terrain', lines: [
    { description: 'Taxi aller-retour', category: 'transport', amount: 12_000 },
    { description: 'Repas déjeuner', category: 'meals', amount: 8_500 },
  ] },
  { title: 'Déplacement client', lines: [
    { description: 'Carburant', category: 'transport', amount: 15_000 },
    { description: 'Péage autoroute du Nord', category: 'transport', amount: 2_500 },
  ] },
  { title: 'Frais de formation', lines: [
    { description: 'Repas midi formation', category: 'meals', amount: 9_000 },
    { description: 'Supports pédagogiques', category: 'supplies', amount: 6_500 },
  ] },
  { title: 'Réunion fournisseurs', lines: [
    { description: 'Déjeuner d\'affaires', category: 'meals', amount: 22_000 },
  ] },
  { title: 'Mission Bouaké', lines: [
    { description: 'Transport interurbain', category: 'transport', amount: 18_000 },
    { description: 'Hébergement 1 nuit', category: 'accommodation', amount: 25_000 },
    { description: 'Repas', category: 'meals', amount: 7_500 },
  ] },
]

const EXPENSE_STATUSES = ['approved', 'submitted', 'paid', 'rejected', 'draft'] as const

/**
 * 1 note de frais (avec lignes) pour ~1 employé sur 3, en faisant tourner les
 * 5 statuts du workflow — chaque onglet de la page Notes de frais est rempli
 * et le manager/RH a toujours des notes « soumises » à valider.
 */
export async function seedExpensesBulk(
  pool: Pool,
  schema: string,
  employeeIds: string[],
): Promise<number> {
  let inserted = 0
  for (let i = 0; i < employeeIds.length; i++) {
    if (i % 3 !== 0) continue
    const tpl = EXPENSE_TEMPLATES[i % EXPENSE_TEMPLATES.length]!
    const status = EXPENSE_STATUSES[(i / 3) % EXPENSE_STATUSES.length]!
    const month = monthOffsetStr(1 + (i % 4))
    const total = tpl.lines.reduce((s, l) => s + l.amount, 0)
    try {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO "${schema}".expense_reports
           (employee_id, title, month, status, submitted_at, total_amount, currency)
         VALUES ($1,$2,$3,$4,
                 CASE WHEN $6 THEN now() - interval '${5 + (i % 20)} days' ELSE NULL END,
                 $5,'XOF')
         ON CONFLICT DO NOTHING RETURNING id`,
        [employeeIds[i]!, tpl.title, month, status, total, status !== 'draft'],
      )
      const reportId = r.rows[0]?.id
      if (!reportId) continue
      inserted++
      for (const line of tpl.lines) {
        await pool.query(
          `INSERT INTO "${schema}".expense_lines
             (report_id, description, category, date, amount, currency)
           VALUES ($1,$2,$3,$4,$5,'XOF')
           ON CONFLICT DO NOTHING`,
          [reportId, line.description, line.category,
           `${month}-${String(randInt(3, 26)).padStart(2, '0')}`, line.amount],
        )
      }
    } catch { /* non bloquant */ }
  }
  return inserted
}

// ── Scoring rétention IA (vue DG « employés à surveiller » + fiche employé) ──
/**
 * Renseigne retention_score / burnout_risk / ai_score_factors pour ~1 employé
 * sur 4 (comme le ferait le job IA nocturne) : le tableau « Employés à
 * surveiller » de la vue DG 360° et l'outil IA get_employees_at_risk sont
 * remplis dès le seed, avec un mix high/medium/low réaliste.
 */
export async function seedRetentionScoresBulk(
  pool: Pool,
  schema: string,
  employeeIds: string[],
): Promise<number> {
  const PROFILES = [
    { score: 0.87, risk: 'high',   factors: ['Salaire au minimum de la grille depuis 18 mois', 'Aucune formation depuis 14 mois', '2 arrêts maladie ce trimestre'] },
    { score: 0.74, risk: 'high',   factors: ['Ancienneté < 18 mois', 'Score d\'engagement 2/5 au dernier entretien'] },
    { score: 0.55, risk: 'medium', factors: ['Aucune évolution de poste depuis 3 ans'] },
    { score: 0.42, risk: 'medium', factors: ['Absences en hausse sur le trimestre'] },
    { score: 0.18, risk: 'low',    factors: ['Promotion récente', 'Formation FDFP suivie cette année'] },
    { score: 0.10, risk: 'low',    factors: ['Engagement 5/5 au dernier entretien'] },
  ] as const

  let updated = 0
  for (let i = 0; i < employeeIds.length; i++) {
    if (i % 4 !== 1) continue
    const p = PROFILES[(updated + i) % PROFILES.length]!
    try {
      await pool.query(
        `UPDATE "${schema}".employees
            SET retention_score = $2, burnout_risk = $3, ai_score_factors = $4
          WHERE id = $1`,
        [employeeIds[i]!, p.score, p.risk, JSON.stringify(p.factors)],
      )
      updated++
    } catch { /* colonnes scoring absentes : non bloquant */ }
  }
  return updated
}

// ── Notes de frais du MOIS COURANT (KPI DG « frais approuvés ce mois ») ──────
/**
 * Quelques notes approuvées/payées datées du mois courant : le KPI DG
 * « frais approuvés ce mois » et les agrégats mensuels frais sont non nuls.
 */
export async function seedCurrentMonthExpensesBulk(
  pool: Pool,
  schema: string,
  employeeIds: string[],
): Promise<number> {
  const month = monthOffsetStr(0)
  const items = [
    { title: 'Mission inspection lignes', status: 'approved', amount: 46_500 },
    { title: 'Réunion partenaires Plateau', status: 'approved', amount: 28_000 },
    { title: 'Carburant tournée dépôts', status: 'paid', amount: 35_500 },
  ] as const

  let inserted = 0
  for (let k = 0; k < items.length && k < employeeIds.length; k++) {
    const it = items[k]!
    try {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO "${schema}".expense_reports
           (employee_id, title, month, status, submitted_at, approved_at, total_amount, currency)
         VALUES ($1,$2,$3,$4, now() - interval '${4 + k} days', now() - interval '${1 + k} days', $5, 'XOF')
         ON CONFLICT DO NOTHING RETURNING id`,
        [employeeIds[(k * 5 + 2) % employeeIds.length]!, it.title, month, it.status, it.amount],
      )
      if (r.rows[0]) {
        inserted++
        await pool.query(
          `INSERT INTO "${schema}".expense_lines
             (report_id, description, category, date, amount, currency)
           VALUES ($1,$2,'transport',$3,$4,'XOF')
           ON CONFLICT DO NOTHING`,
          [r.rows[0].id, it.title, `${month}-${String(randInt(2, 10)).padStart(2, '0')}`, it.amount],
        )
      }
    } catch { /* non bloquant */ }
  }
  return inserted
}

// ── Inscriptions formation ────────────────────────────────────────────────────
/**
 * Remplit les sessions planifiées (8-12 inscrits chacune, places restantes > 0)
 * et crée une session PASSÉE terminée avec des inscriptions « completed »
 * (l'onglet Inscriptions montre les deux états).
 */
export async function seedEnrollmentsBulk(
  pool: Pool,
  schema: string,
  employeeIds: string[],
  sessionIds: string[],
): Promise<number> {
  let inserted = 0
  for (let si = 0; si < sessionIds.length; si++) {
    const count = Math.min(randInt(8, 12), Math.max(employeeIds.length - 1, 1))
    for (let k = 0; k < count; k++) {
      const empIdx = (si * 7 + k * 3) % employeeIds.length
      try {
        await pool.query(
          `INSERT INTO "${schema}".training_enrollments (employee_id, session_id, status)
           VALUES ($1,$2,'enrolled')
           ON CONFLICT DO NOTHING`,
          [employeeIds[empIdx]!, sessionIds[si]!],
        )
        inserted++
      } catch { /* non bloquant */ }
    }
  }

  // Session passée terminée + inscriptions complétées (attestations)
  if (sessionIds[0]) {
    try {
      const tr = await pool.query<{ training_id: string }>(
        `SELECT training_id FROM "${schema}".training_sessions WHERE id = $1`,
        [sessionIds[0]],
      )
      const trainingId = tr.rows[0]?.training_id
      if (trainingId) {
        const past = await pool.query<{ id: string }>(
          `INSERT INTO "${schema}".training_sessions
             (training_id, start_date, end_date, location, trainer, max_places, status)
           VALUES ($1,$2,$3,'Salle de formation','Formateur FDFP',20,'completed')
           ON CONFLICT DO NOTHING RETURNING id`,
          [trainingId, dateOffsetStr(-45), dateOffsetStr(-44)],
        )
        const pastId = past.rows[0]?.id
        if (pastId) {
          for (let k = 0; k < Math.min(6, employeeIds.length); k++) {
            await pool.query(
              `INSERT INTO "${schema}".training_enrollments
                 (employee_id, session_id, status, completed_at)
               VALUES ($1,$2,'completed', now() - interval '40 days')
               ON CONFLICT DO NOTHING`,
              [employeeIds[(k * 5) % employeeIds.length]!, pastId],
            )
            inserted++
          }
        }
      }
    } catch { /* non bloquant */ }
  }
  return inserted
}

// ── Compétences + évaluations (9-box rempli) ─────────────────────────────────
/**
 * Compétences (5-7 par employé, avec niveau cible) et évaluation annuelle
 * « completed » de l'ANNÉE COURANTE pour tous — le 9-box lit l'année courante
 * et les scores sont répartis pour remplir les 9 cases (perf × potentiel).
 * `upcomingFor` reçoit en plus un entretien de mi-année en brouillon
 * (widget « Entretiens à venir » de l'espace employé).
 */
export async function seedSkillsEvaluationsBulk(
  pool: Pool,
  schema: string,
  employeeIds: string[],
  skillIds: string[],
  evaluatorUserEmail?: string,
  upcomingFor: string[] = [],
): Promise<void> {
  let evaluatorId: string | null = null
  if (evaluatorUserEmail) {
    try {
      const u = await pool.query<{ id: string }>(
        `SELECT id FROM "${schema}".users WHERE email = $1 LIMIT 1`, [evaluatorUserEmail])
      evaluatorId = u.rows[0]?.id ?? null
    } catch { /* non bloquant */ }
  }

  const year = new Date().getFullYear()
  // 9 combinaisons (performance × potentiel) : bas / moyen / haut
  const bands: ReadonlyArray<[number, number]> = [
    [2.2, 2.4], [2.5, 3.6], [2.3, 4.4],
    [3.4, 2.5], [3.6, 3.5], [3.5, 4.6],
    [4.5, 2.6], [4.4, 3.7], [4.7, 4.8],
  ]

  for (let i = 0; i < employeeIds.length; i++) {
    const id = employeeIds[i]!
    // Compétences : 5 à 7 par employé, niveaux variés + cible
    const nbSkills = Math.min(5 + (i % 3), skillIds.length)
    for (let si = 0; si < nbSkills; si++) {
      const level = 1 + ((i + si) % 5)
      const target = Math.min(level + (si % 2 === 0 ? 1 : 0), 5)
      try {
        await pool.query(
          `INSERT INTO "${schema}".employee_skills (employee_id, skill_id, level, target_level)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (employee_id, skill_id) DO UPDATE
             SET level = EXCLUDED.level, target_level = EXCLUDED.target_level`,
          [id, skillIds[(si * 2 + i) % skillIds.length]!, level, target],
        )
      } catch { /* non bloquant */ }
    }

    // Évaluation annuelle COMPLETED de l'année courante (alimente le 9-box)
    const [perf, pot] = bands[i % bands.length]!
    const jitter = (n: number): string => Math.min(5, Math.max(1, n + (i % 3) * 0.1)).toFixed(1)
    try {
      await pool.query(
        `INSERT INTO "${schema}".evaluations
           (employee_id, evaluator_id, year, type, status,
            global_score, performance_score, skills_score,
            strengths, improvements, manager_comments, completed_at)
         VALUES ($1,$2,$3,'annual','completed',$4,$4,$5,
                 '["Ponctualité","Fiabilité","Esprit d''équipe"]',
                 '["Développer les compétences informatiques"]',
                 'Entretien annuel réalisé — objectifs définis pour l''année.',
                 now() - interval '${10 + (i % 60)} days')
         ON CONFLICT DO NOTHING`,
        [id, evaluatorId, year, jitter(perf), jitter(pot)],
      )
    } catch { /* non bloquant */ }
  }

  // Entretiens « à venir » (brouillon mi-année) pour les employés nommés
  for (const id of upcomingFor) {
    try {
      await pool.query(
        `INSERT INTO "${schema}".evaluations
           (employee_id, evaluator_id, year, type, status, manager_comments)
         VALUES ($1,$2,$3,'mid_year','draft','Entretien de mi-année à planifier.')
         ON CONFLICT DO NOTHING`,
        [id, evaluatorId, year],
      )
    } catch { /* non bloquant */ }
  }
}

// ── Événements RH ─────────────────────────────────────────────────────────────
/** Embauche pour chaque employé + promotion/augmentation pour ~1 sur 5. */
export async function seedHrEventsBulk(pool: Pool, schema: string): Promise<void> {
  try {
    await pool.query(`
      INSERT INTO "${schema}".hr_events (employee_id, type, title, description, date)
      SELECT id, 'hire', 'Embauche', 'Entrée dans l''entreprise', hire_date
        FROM "${schema}".employees
       WHERE hire_date IS NOT NULL AND deleted_at IS NULL
    `)
    await pool.query(`
      INSERT INTO "${schema}".hr_events (employee_id, type, title, description, date)
      SELECT id,
             CASE WHEN random() < 0.5 THEN 'promotion' ELSE 'salary_increase' END,
             CASE WHEN random() < 0.5 THEN 'Promotion' ELSE 'Augmentation de salaire' END,
             'Évolution de carrière enregistrée par la RH',
             (now() - (interval '1 day' * floor(random() * 300 + 30)))::date
        FROM "${schema}".employees
       WHERE deleted_at IS NULL AND random() < 0.2
    `)
  } catch { /* tenant sans hr_events : non bloquant */ }
}

// ── Notifications ─────────────────────────────────────────────────────────────
/** 3 notifications par utilisateur du tenant (mix lu / non lu) — inbox jamais vide. */
export async function seedNotificationsBulk(pool: Pool, schema: string): Promise<void> {
  const items: ReadonlyArray<[string, string, string, boolean]> = [
    ['payroll', 'Bulletin disponible', 'Votre bulletin de paie du mois dernier est disponible dans votre espace.', false],
    ['absence', 'Demande d\'absence', 'Une demande d\'absence attend votre validation ou a été traitée.', false],
    ['training', 'Session de formation', 'Une session de formation planifiée approche — pensez à confirmer votre présence.', true],
  ]
  for (const [type, title, message, isRead] of items) {
    try {
      await pool.query(
        `INSERT INTO "${schema}".notifications (user_id, type, title, message, is_read)
         SELECT id, $1, $2, $3, $4 FROM "${schema}".users WHERE is_active = true`,
        [type, title, message, isRead],
      )
    } catch { /* non bloquant */ }
  }
}

// ── Mobile Money — campagne d'un mois clos ────────────────────────────────────
/**
 * Matérialise la campagne de virement des salaires d'un mois clos :
 * 1 paiement par bulletin du mois (lié au pay_slip → filtre mois de l'UI),
 * ~95 % complétés, quelques échecs et paiements en attente pour illustrer
 * tous les badges de statut.
 */
export async function seedMobileMoneyCampaign(
  pool: Pool,
  schema: string,
  month: string,
): Promise<number> {
  try {
    const r = await pool.query(`
      INSERT INTO "${schema}".mobile_money_payments
        (employee_id, pay_slip_id, provider, phone_number, amount, currency,
         reference, external_ref, status, error_message, initiated_at, confirmed_at)
      SELECT e.id, s.id,
             COALESCE(e.mobile_money_provider, 'wave'),
             COALESCE(e.mobile_money_phone, ''),
             s.net_payable, 'XOF',
             'CAMP_' || replace($1, '-', '') || '_' || substr(s.id::text, 1, 8),
             CASE WHEN s.rn % 37 IN (5, 11) THEN NULL
                  ELSE 'MM-' || upper(substr(md5(s.id::text), 1, 10)) END,
             CASE WHEN s.rn % 37 = 5  THEN 'failed'
                  WHEN s.rn % 37 = 11 THEN 'pending'
                  ELSE 'completed' END,
             CASE WHEN s.rn % 37 = 5
                  THEN 'Numéro Mobile Money invalide ou compte inactif' END,
             now() - interval '3 days',
             CASE WHEN s.rn % 37 NOT IN (5, 11) THEN now() - interval '3 days' END
        FROM (SELECT ps.*, row_number() OVER (ORDER BY ps.id) AS rn
                FROM "${schema}".pay_slips ps WHERE ps.month = $1) s
        JOIN "${schema}".employees e ON e.id = s.employee_id
      ON CONFLICT DO NOTHING
    `, [month])
    return r.rowCount ?? 0
  } catch {
    return 0 // tenant sans mobile_money_payments : non bloquant
  }
}

// ── Déclarations CNPS trimestrielles ──────────────────────────────────────────
/**
 * Génère les déclarations CNPS des trimestres couverts par les bulletins
 * (même agrégation que la route POST /cnps/declarations/generate).
 * Les trimestres passés sont « submitted », le plus récent reste « draft »
 * pour laisser la démo dérouler le workflow Valider → Exporter.
 */
export async function seedCnpsDeclarationsFromPayslips(
  pool: Pool,
  schema: string,
  months: string[],
): Promise<number> {
  // Regrouper les mois par (année, trimestre)
  const quarters = new Map<string, { year: number; quarter: number; months: string[] }>()
  for (const m of months) {
    const [y, mo] = m.split('-').map(Number)
    if (!y || !mo) continue
    const q = Math.ceil(mo / 3)
    const key = `${y}-Q${q}`
    const entry = quarters.get(key) ?? { year: y, quarter: q, months: [] }
    entry.months.push(m)
    quarters.set(key, entry)
  }
  const ordered = [...quarters.values()].sort((a, b) => a.year - b.year || a.quarter - b.quarter)

  let created = 0
  for (let qi = 0; qi < ordered.length; qi++) {
    const { year, quarter } = ordered[qi]!
    // Mois COMPLETS du trimestre (la déclaration officielle couvre le trimestre entier)
    const quarterMonths: string[] = []
    for (let m = (quarter - 1) * 3 + 1; m <= quarter * 3; m++) {
      quarterMonths.push(`${year}-${String(m).padStart(2, '0')}`)
    }
    try {
      const agg = await pool.query<{
        employee_id: string; first_name: string; last_name: string
        cnps_number: string; nni: string
        total_cnps_sal: string; total_cnps_pat: string
        cnps_retraite_sal: string; cnps_retraite_pat: string
        cnps_pf_pat: string; cnps_at_pat: string
        gross_salary: string; net_payable: string
      }>(
        `SELECT e.id AS employee_id, e.first_name, e.last_name,
                COALESCE(e.cnps_number,'') AS cnps_number,
                COALESCE(e.nni,'') AS nni,
                SUM(COALESCE(ps.total_cnps_sal,0))::text AS total_cnps_sal,
                SUM(COALESCE(ps.total_cnps_pat,0))::text AS total_cnps_pat,
                SUM(COALESCE(ps.cnps_retraite_sal,0))::text AS cnps_retraite_sal,
                SUM(COALESCE(ps.cnps_retraite_pat,0))::text AS cnps_retraite_pat,
                SUM(COALESCE(ps.cnps_pf_pat,0))::text AS cnps_pf_pat,
                SUM(COALESCE(ps.cnps_at_pat,0))::text AS cnps_at_pat,
                SUM(COALESCE(ps.gross_salary,0))::text AS gross_salary,
                SUM(COALESCE(ps.net_payable,0))::text AS net_payable
           FROM "${schema}".pay_slips ps
           JOIN "${schema}".employees e ON e.id = ps.employee_id
          WHERE ps.month = ANY($1::text[])
          GROUP BY e.id, e.first_name, e.last_name, e.cnps_number, e.nni`,
        [quarterMonths],
      )
      if (agg.rows.length === 0) continue

      let totalSalarial = 0
      let totalPatronal = 0
      let masseSalariale = 0
      for (const row of agg.rows) {
        totalSalarial += parseInt(row.total_cnps_sal ?? '0', 10)
        totalPatronal += parseInt(row.total_cnps_pat ?? '0', 10)
        masseSalariale += parseInt(row.gross_salary ?? '0', 10)
      }

      const isLatest = qi === ordered.length - 1
      // Échéance e-CNPS : le 15 du mois suivant la fin du trimestre
      const dueDate = new Date(year, quarter * 3, 15).toISOString().slice(0, 10)
      await pool.query(
        `INSERT INTO "${schema}".cnps_declarations
           (year, quarter, months,
            total_cotisations_salariales, total_cotisations_patronales,
            total_cotisations, masse_salariale, employees_count, data,
            status, submitted_at, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 CASE WHEN $12 THEN now() ELSE NULL END, $11)
         ON CONFLICT (year, quarter) DO NOTHING`,
        [year, quarter, JSON.stringify(quarterMonths),
         totalSalarial, totalPatronal, totalSalarial + totalPatronal,
         masseSalariale, agg.rows.length, JSON.stringify(agg.rows),
         isLatest ? 'draft' : 'submitted', dueDate, !isLatest],
      )
      created++
    } catch { /* non bloquant */ }
  }
  return created
}

// ── DISA annuelle ─────────────────────────────────────────────────────────────
/** DISA générée pour une année à partir des bulletins existants. */
export async function seedDisaFromPayslips(
  pool: Pool,
  schema: string,
  year: number,
): Promise<void> {
  try {
    const agg = await pool.query<{
      employee_id: string; first_name: string; last_name: string
      cnps_number: string; nni: string
      gross_salary: string; total_cnps: string; its: string
    }>(
      `SELECT e.id AS employee_id, e.first_name, e.last_name,
              COALESCE(e.cnps_number,'') AS cnps_number,
              COALESCE(e.nni,'') AS nni,
              SUM(COALESCE(ps.gross_salary,0))::text AS gross_salary,
              SUM(COALESCE(ps.total_cnps_sal,0) + COALESCE(ps.total_cnps_pat,0))::text AS total_cnps,
              SUM(COALESCE(ps.its,0))::text AS its
         FROM "${schema}".pay_slips ps
         JOIN "${schema}".employees e ON e.id = ps.employee_id
        WHERE ps.month LIKE $1
        GROUP BY e.id, e.first_name, e.last_name, e.cnps_number, e.nni`,
      [`${year}-%`],
    )
    if (agg.rows.length === 0) return

    let masse = 0
    let cnps = 0
    let its = 0
    for (const row of agg.rows) {
      masse += parseInt(row.gross_salary ?? '0', 10)
      cnps += parseInt(row.total_cnps ?? '0', 10)
      its += parseInt(row.its ?? '0', 10)
    }
    await pool.query(
      `INSERT INTO "${schema}".disa_records
         (year, employees_count, masse_salariale, total_cnps, total_its, data, status)
       VALUES ($1,$2,$3,$4,$5,$6,'generated')
       ON CONFLICT (year) DO NOTHING`,
      [year, agg.rows.length, masse, cnps, its, JSON.stringify(agg.rows)],
    )
  } catch { /* non bloquant */ }
}

// ── Candidatures de démo pour une offre ───────────────────────────────────────
const DEMO_CANDIDATES: ReadonlyArray<[string, string]> = [
  ['Aya', 'Kouadio'], ['Moussa', 'Sanogo'], ['Affoué', 'N\'Dri'], ['Idriss', 'Ouédraogo'],
  ['Mariam', 'Cissé'], ['Franck', 'Aka'], ['Nadia', 'Gnaoré'], ['Olivier', 'Tanoh'],
]

/**
 * Remplit le pipeline kanban d'une offre : candidatures réparties sur tous les
 * stages, dont une partie avec scoring IA pré-calculé (cartes colorées).
 */
export async function seedApplicationsForJob(
  pool: Pool,
  schema: string,
  jobId: string,
  count: number,
): Promise<void> {
  const stages = ['new', 'screening', 'interview', 'test', 'offer', 'hired', 'rejected'] as const
  for (let i = 0; i < Math.min(count, DEMO_CANDIDATES.length); i++) {
    const [fn, ln] = DEMO_CANDIDATES[i]!
    const stage = stages[i % stages.length]!
    const hasAi = i % 2 === 0
    const aiScore = hasAi ? randInt(55, 94) : null
    const aiRec = hasAi
      ? (aiScore! >= 85 ? 'strong_yes' : aiScore! >= 70 ? 'yes' : 'maybe')
      : null
    try {
      await pool.query(
        `INSERT INTO "${schema}".applications
           (job_id, first_name, last_name, email, phone, stage, source,
            ai_score, ai_recommendation, ai_match_percentage,
            ai_summary, ai_strengths, ai_gaps, ai_model_used, ai_analyzed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'careers_page',$7,$8,$7,$9,$10,$11,$12,
                 CASE WHEN $7::int IS NULL THEN NULL ELSE now() END)
         ON CONFLICT DO NOTHING`,
        [jobId, fn, ln,
         `${fn.toLowerCase().replace(/[^a-z]/g, '')}.${ln.toLowerCase().replace(/[^a-z]/g, '')}@email.com`,
         `+22507${randInt(10000000, 99999999)}`, stage,
         aiScore, aiRec,
         hasAi ? `Profil ${aiRec === 'strong_yes' ? 'très aligné' : 'aligné'} avec les prérequis du poste.` : null,
         hasAi ? JSON.stringify(['Expérience confirmée', 'Bonne communication']) : JSON.stringify([]),
         hasAi ? JSON.stringify(['Mobilité à confirmer']) : JSON.stringify([]),
         hasAi ? 'claude' : null],
      )
    } catch { /* non bloquant */ }
  }
}
