/**
 * Seed — données d'exemple des modules talents & cycle de vie.
 *
 * Remplit avec des exemples cohérents : gestion disciplinaire, processus de
 * sortie (offboarding), enquête climat social, plans de succession, référentiel
 * postes/compétences (Bloom) et session de calibrage 9-box. Générique (tout
 * schéma tenant) et IDEMPOTENT (saute une table déjà peuplée). L'organigramme
 * est dérivé de departments/employees → aucun seed dédié.
 */
import type { Pool } from 'pg'
import { dateOffsetStr } from './seed-demo-data.js'

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export async function seedTalentLifecycleBulk(pool: Pool, schema: string, employeeIds: string[]): Promise<void> {
  if (employeeIds.length === 0) return
  const ids = employeeIds
  const year = new Date().getFullYear()

  const hasRows = async (table: string): Promise<boolean> => {
    try {
      const r = await pool.query(`SELECT 1 FROM "${schema}".${table} LIMIT 1`)
      return r.rows.length > 0
    } catch {
      return true // table absente (schéma non migré) → on n'insère pas
    }
  }

  // 1. Gestion disciplinaire
  if (!(await hasRows('disciplinary_actions'))) {
    const rows: Array<{ type: string; status: string; reason: string }> = [
      { type: 'observation', status: 'issued', reason: 'Retards répétés constatés' },
      { type: 'avertissement', status: 'issued', reason: 'Non-respect des consignes de sécurité' },
      { type: 'blame', status: 'draft', reason: 'Manquement aux obligations professionnelles' },
    ]
    for (let i = 0; i < Math.min(rows.length, ids.length); i++) {
      const r = rows[i]!
      await pool.query(
        `INSERT INTO "${schema}".disciplinary_actions (employee_id, type, reason, action_date, status)
         VALUES ($1,$2,$3,$4,$5)`,
        [ids[i], r.type, r.reason, dateOffsetStr(-randInt(20, 120)), r.status],
      )
    }
  }

  // 2. Processus de sortie (offboarding)
  if (!(await hasRows('offboarding_cases'))) {
    const checklist = JSON.stringify([
      { key: 'badge', label: 'Restitution du badge', done: true },
      { key: 'materiel_informatique', label: 'Restitution du materiel informatique (PC)', done: false },
      { key: 'acces_si', label: 'Revocation des acces SI', done: false },
      { key: 'documents_rh', label: 'Remise des documents RH (certificat, solde)', done: false },
    ])
    const cases: Array<{ type: string; status: string; notice: boolean }> = [
      { type: 'demission', status: 'in_progress', notice: true },
      { type: 'licenciement', status: 'open', notice: false },
    ]
    for (let i = 0; i < Math.min(cases.length, ids.length); i++) {
      const c = cases[i]!
      await pool.query(
        `INSERT INTO "${schema}".offboarding_cases (employee_id, departure_type, departure_date, reason, status, checklist, notice_served)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ids[ids.length - 1 - i], c.type, dateOffsetStr(randInt(10, 45)), 'Dossier de sortie', c.status, checklist, c.notice],
      )
    }
  }

  // 3. Enquete climat social (1 ouverte + reponses)
  if (!(await hasRows('climate_surveys'))) {
    const questions = JSON.stringify([
      { key: 'q1', label: 'Etes-vous satisfait de votre environnement de travail ?', type: 'scale' },
      { key: 'q2', label: "Recommanderiez-vous l'entreprise a un proche ?", type: 'boolean' },
      { key: 'q3', label: 'Une suggestion pour ameliorer le quotidien ?', type: 'text' },
    ])
    const s = await pool.query<{ id: string }>(
      `INSERT INTO "${schema}".climate_surveys (title, description, status, anonymous, questions)
       VALUES ($1,$2,'open',true,$3) RETURNING id`,
      [`Barometre social ${year}`, "Enquete d'engagement trimestrielle", questions],
    )
    const surveyId = s.rows[0]?.id
    if (surveyId) {
      const answers = [
        { q1: 5, q2: true, q3: 'Tres bonne ambiance' }, { q1: 3, q2: false, q3: '' },
        { q1: 4, q2: true, q3: 'Plus de teletravail' }, { q1: 4, q2: true, q3: '' },
        { q1: 2, q2: false, q3: 'Charge de travail elevee' }, { q1: 5, q2: true, q3: '' },
      ]
      for (let i = 0; i < Math.min(answers.length, ids.length); i++) {
        await pool.query(
          `INSERT INTO "${schema}".climate_responses (survey_id, employee_id, answers)
           VALUES ($1,$2,$3) ON CONFLICT (survey_id, employee_id) DO NOTHING`,
          [surveyId, ids[i], JSON.stringify(answers[i])],
        )
      }
    }
  }

  // 4. Plan de succession (poste cle + viviers)
  if (!(await hasRows('succession_plans'))) {
    const plan = await pool.query<{ id: string }>(
      `INSERT INTO "${schema}".succession_plans (position_title, incumbent_employee_id, criticality, status, notes)
       VALUES ($1,$2,'critical','active',$3) RETURNING id`,
      ['Directeur des Operations', ids[0] ?? null, 'Poste cle identifie en comite de direction'],
    )
    const planId = plan.rows[0]?.id
    if (planId) {
      const readiness = ['ready_now', 'short_term', 'medium_term']
      for (let i = 1; i < Math.min(4, ids.length); i++) {
        await pool.query(
          `INSERT INTO "${schema}".succession_candidates (plan_id, employee_id, readiness)
           VALUES ($1,$2,$3) ON CONFLICT (plan_id, employee_id) DO NOTHING`,
          [planId, ids[i], readiness[(i - 1) % readiness.length]],
        )
      }
    }
  }

  // 5. Referentiel postes & competences (Bloom)
  if (!(await hasRows('competency_framework'))) {
    const comps: Array<[string, string, number]> = [
      ['Communication', 'Comportementales', 3], ['Leadership', 'Management', 4],
      ['Excel / Bureautique', 'Techniques', 3], ['Gestion de projet', 'Management', 4],
      ['Analyse de donnees', 'Techniques', 5], ['Service client', 'Metier', 3],
    ]
    const compIds: string[] = []
    for (const [label, cat, bl] of comps) {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO "${schema}".competency_framework (label, category, bloom_level) VALUES ($1,$2,$3) RETURNING id`,
        [label, cat, bl],
      )
      if (r.rows[0]) compIds.push(r.rows[0].id)
    }
    const profiles: Array<{ title: string; mission: string; level: string; reqs: Array<[number, number]> }> = [
      { title: "Chef d'equipe", mission: 'Encadrer une equipe operationnelle', level: 'Maitrise', reqs: [[0, 3], [1, 4], [3, 3]] },
      { title: 'Analyste', mission: 'Produire les analyses et reportings', level: 'Confirme', reqs: [[2, 4], [4, 5], [0, 3]] },
    ]
    for (const p of profiles) {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO "${schema}".job_profiles (title, mission, category, level) VALUES ($1,$2,'Cadre',$3) RETURNING id`,
        [p.title, p.mission, p.level],
      )
      const jpId = r.rows[0]?.id
      if (!jpId) continue
      for (const [ci, lvl] of p.reqs) {
        const cid = compIds[ci]
        if (cid) {
          await pool.query(
            `INSERT INTO "${schema}".job_profile_competencies (job_profile_id, competency_id, required_level)
             VALUES ($1,$2,$3) ON CONFLICT (job_profile_id, competency_id) DO NOTHING`,
            [jpId, cid, lvl],
          )
        }
      }
    }
  }

  // 6. Session de calibrage 9-box
  if (!(await hasRows('calibration_sessions'))) {
    const sess = await pool.query<{ id: string }>(
      `INSERT INTO "${schema}".calibration_sessions (title, session_date, scope, status)
       VALUES ($1,$2,$3,'in_progress') RETURNING id`,
      [`Calibrage annuel ${year}`, dateOffsetStr(-15), 'Encadrement'],
    )
    const sessId = sess.rows[0]?.id
    if (sessId) {
      for (let i = 0; i < Math.min(8, ids.length); i++) {
        const pb = randInt(1, 3), tb = randInt(1, 3)
        const pa = Math.min(3, pb + (Math.random() < 0.4 ? 1 : 0))
        await pool.query(
          `INSERT INTO "${schema}".calibration_entries (session_id, employee_id, performance_before, potential_before, performance_after, potential_after)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (session_id, employee_id) DO NOTHING`,
          [sessId, ids[i], pb, tb, pa, tb],
        )
      }
    }
  }
}
