import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { z } from 'zod'
import { config } from '../../config.js'
import { ensureRecruitmentSchemaMigrated } from '../../db/provisioning.js'
import {
  analyzeCV, isModelAvailable,
  sourceProfiles, sourceProfilesCompare,
  type AiModelChoice, type JobContext, type SourcingContext,
  type RecruiterDecisionExample,
} from '../../services/recruitment-ai.service.js'
import { sanitizeCriteria } from '../../services/recruitment-screening.service.js'

const pool = new Pool({ connectionString: config.database.url })

/**
 * Extrait le texte d'un CV uploadé. Pour les PDF, utilise unpdf (extraction
 * native, sans dépendance binaire externe). Pour les .txt, décode en UTF-8.
 * Les .doc/.docx tombent en fallback UTF-8 — extraction native via mammoth
 * dans un sprint suivant. En cas d'échec d'extraction (PDF corrompu, etc.),
 * fallback UTF-8 pour ne pas bloquer l'upload.
 */
async function extractCvText(buf: Buffer, mimetype: string): Promise<string> {
  const MAX = 50_000
  if (mimetype === 'application/pdf') {
    try {
      const { getDocumentProxy, extractText } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(buf))
      const result = await extractText(pdf, { mergePages: true })
      const text = Array.isArray(result.text) ? result.text.join('\n') : (result.text ?? '')
      const cleaned = text.replace(/\s+/g, ' ').trim()
      if (cleaned.length > 0) return cleaned.slice(0, MAX)
    } catch {
      // PDF illisible : fallback UTF-8 (texte garbage probable mais l'IA
      // détectera la non-cohérence et retournera un CV trop court)
    }
  }
  return buf.toString('utf-8').slice(0, MAX)
}

// Schéma Zod pour la candidature publique — OWASP A03 (Injection) + A04
// (Insecure Design). Limites stricts pour éviter spam et XSS.
const publicApplySchema = z.object({
  first_name:   z.string().min(1, 'Prénom requis').max(100).trim(),
  last_name:    z.string().min(1, 'Nom requis').max(100).trim(),
  email:        z.string().email('Email invalide').max(255).toLowerCase(),
  phone:        z.string().max(30).optional(),
  cover_letter: z.string().max(5000, 'Lettre de motivation trop longue (max 5000)').optional(),
  cv_text:      z.string().max(50000).optional(),
})

type JobBody = {
  title?: string
  department_id?: string | null
  location?: string
  contract_type?: string
  salary_min?: number | string | null
  salary_max?: number | string | null
  description?: string | null
  requirements?: string | null
  status?: string
  visibility?: 'external' | 'internal' | 'both'
  target_departments?: string[]
  target_job_levels?: string[]
  target_min_seniority_months?: number | null
  target_legal_entity_id?: string | null
  hiring_manager_id?: string | null
}

const STAGES = ['new', 'screening', 'interview', 'test', 'offer', 'hired', 'rejected']
const VISIBILITIES = ['external', 'internal', 'both']

function slugifyTitle(title: string): string {
  return title.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    .slice(0, 80)
}

function scoreToRecommendation(score: number | null): string | null {
  if (score === null || score === undefined) return null
  if (score >= 85) return 'strong_yes'
  if (score >= 70) return 'yes'
  if (score >= 55) return 'maybe'
  return 'no'
}

const recruitmentRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Capabilités IA (pour le sélecteur UI) ──────────────────────────────────
  fastify.get('/ai/capabilities', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (_req, reply) => reply.send({
      claude:  isModelAvailable('claude'),
      mistral: isModelAvailable('mistral'),
    }),
  })

  // ── OFFRES ─────────────────────────────────────────────────────────────────
  fastify.get('/jobs', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { status, visibility, limit = '50', offset = '0' } = request.query as Record<string, string>
      let sql = `SELECT rj.*, d.name AS department_name,
                   COUNT(a.id)::int AS applications_count
                 FROM "${schema}".recruitment_jobs rj
                 LEFT JOIN "${schema}".departments d ON d.id = rj.department_id
                 LEFT JOIN "${schema}".applications a ON a.job_id = rj.id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (status) { sql += ` AND rj.status = $${idx++}`; params.push(status) }
      if (visibility) { sql += ` AND rj.visibility = $${idx++}`; params.push(visibility) }
      sql += ` GROUP BY rj.id, d.name ORDER BY rj.created_at DESC`
      sql += ` LIMIT $${idx++} OFFSET $${idx++}`
      params.push(parseInt(limit), parseInt(offset))
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  fastify.post('/jobs', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const body = request.body as JobBody
      if (!body.title) return reply.status(400).send({ error: 'Titre requis' })
      const visibility = VISIBILITIES.includes(body.visibility ?? '')
        ? body.visibility! : 'external'
      const status = body.status || 'open'
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".recruitment_jobs
            (title, department_id, location, contract_type, salary_min, salary_max,
             description, requirements, status, published_at, created_by,
             visibility, target_departments, target_job_levels,
             target_min_seniority_months, target_legal_entity_id, hiring_manager_id,
             public_slug)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
          RETURNING *
        `, [
          body.title, body.department_id || null,
          body.location || 'Abidjan', body.contract_type || 'cdi',
          body.salary_min || null, body.salary_max || null,
          body.description || null, body.requirements || null,
          status, status === 'open' ? new Date() : null,
          request.user.sub,
          visibility,
          body.target_departments && body.target_departments.length ? body.target_departments : [],
          body.target_job_levels && body.target_job_levels.length ? body.target_job_levels : [],
          body.target_min_seniority_months ?? null,
          body.target_legal_entity_id || null,
          body.hiring_manager_id || null,
          slugifyTitle(body.title),
        ])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  fastify.get('/jobs/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      try {
        const jobRes = await pool.query(`
          SELECT rj.*, d.name AS department_name
          FROM "${schema}".recruitment_jobs rj
          LEFT JOIN "${schema}".departments d ON d.id = rj.department_id
          WHERE rj.id = $1
        `, [id])
        if (!jobRes.rows[0]) return reply.status(404).send({ error: 'Offre introuvable' })
        const appsRes = await pool.query(
          `SELECT * FROM "${schema}".applications WHERE job_id = $1 ORDER BY created_at DESC`, [id]
        )
        return reply.send({ data: { ...jobRes.rows[0], applications: appsRes.rows } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  fastify.patch('/jobs/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      const body = request.body as JobBody
      const scalarFields: Array<keyof JobBody> = [
        'title', 'department_id', 'location', 'contract_type',
        'salary_min', 'salary_max', 'description', 'requirements', 'status',
        'target_min_seniority_months', 'target_legal_entity_id', 'hiring_manager_id',
      ]
      const updates: string[] = []
      const values: unknown[] = []
      for (const f of scalarFields) {
        if (f in body) { updates.push(`${f} = $${values.length + 1}`); values.push(body[f] ?? null) }
      }
      if ('visibility' in body && VISIBILITIES.includes(body.visibility ?? '')) {
        updates.push(`visibility = $${values.length + 1}`)
        values.push(body.visibility)
      }
      if ('target_departments' in body) {
        updates.push(`target_departments = $${values.length + 1}`)
        values.push(body.target_departments ?? [])
      }
      if ('target_job_levels' in body) {
        updates.push(`target_job_levels = $${values.length + 1}`)
        values.push(body.target_job_levels ?? [])
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      updates.push(`updated_at = now()`)
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".recruitment_jobs SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
          values,
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /recruitment/jobs/:id/screening-criteria — règles de pré-tri de l'offre.
  // Retourne toujours une forme canonique (sanitizeCriteria) même si la colonne
  // est NULL → le panneau frontend s'hydrate avec des valeurs par défaut sûres.
  fastify.get('/jobs/:id/screening-criteria', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      try {
        const res = await pool.query<{ screening_criteria: unknown }>(
          `SELECT screening_criteria FROM "${schema}".recruitment_jobs WHERE id = $1 LIMIT 1`,
          [id],
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Offre introuvable' })
        return reply.send({ data: { criteria: sanitizeCriteria(res.rows[0].screening_criteria ?? {}) } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PUT /recruitment/jobs/:id/screening-criteria — enregistre les règles de pré-tri.
  // OWASP A03 : sanitizeCriteria borne/normalise toutes les entrées (listes,
  // entiers, diplôme whitelisté) avant persistance dans la colonne jsonb.
  fastify.put('/jobs/:id/screening-criteria', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as { criteria?: unknown }
      const clean = sanitizeCriteria(body.criteria ?? {})
      try {
        const res = await pool.query<{ id: string }>(
          `UPDATE "${schema}".recruitment_jobs SET screening_criteria = $1, updated_at = now()
           WHERE id = $2 RETURNING id`,
          [JSON.stringify(clean), id],
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Offre introuvable' })
        return reply.send({ data: { criteria: clean } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  fastify.delete('/jobs/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        await pool.query(`DELETE FROM "${schema}".recruitment_jobs WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── OFFRES INTERNES (côté employé) ─────────────────────────────────────────
  // Filtre les offres visibility ∈ {internal, both} dont les critères matchent
  // le profil de l'employé connecté.
  fastify.get('/internal-jobs', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      try {
        // Récupère l'employé lié au user connecté
        const empRes = await pool.query<{
          id: string
          department_id: string | null
          job_level: string | null
          hire_date: string | null
          legal_entity_id: string | null
        }>(
          `SELECT id, department_id, job_level, hire_date, legal_entity_id
             FROM "${schema}".employees
             WHERE user_id = $1 OR email = $2
             ORDER BY user_id IS NOT NULL DESC
             LIMIT 1`,
          [request.user.sub, request.user.email],
        )
        const emp = empRes.rows[0]
        if (!emp) return reply.send({ data: [] })

        const seniorityMonths = emp.hire_date
          ? Math.max(0, Math.floor(
              (Date.now() - new Date(emp.hire_date).getTime()) / (1000 * 60 * 60 * 24 * 30.4375),
            ))
          : 0

        const res = await pool.query(`
          SELECT rj.*, d.name AS department_name,
                 COUNT(a.id) FILTER (WHERE a.internal_employee_id = $1)::int AS already_applied
          FROM "${schema}".recruitment_jobs rj
          LEFT JOIN "${schema}".departments d ON d.id = rj.department_id
          LEFT JOIN "${schema}".applications a ON a.job_id = rj.id
          WHERE rj.visibility IN ('internal','both')
            AND rj.status = 'open'
            AND (COALESCE(cardinality(rj.target_departments), 0) = 0
                 OR ($2::uuid IS NOT NULL AND $2::uuid = ANY(rj.target_departments)))
            AND (COALESCE(cardinality(rj.target_job_levels), 0) = 0
                 OR ($3::varchar IS NOT NULL AND $3::varchar = ANY(rj.target_job_levels)))
            AND (rj.target_min_seniority_months IS NULL
                 OR rj.target_min_seniority_months <= $4::int)
            AND (rj.target_legal_entity_id IS NULL
                 OR rj.target_legal_entity_id = $5::uuid)
          GROUP BY rj.id, d.name
          ORDER BY rj.created_at DESC
        `, [emp.id, emp.department_id, emp.job_level, seniorityMonths, emp.legal_entity_id])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /recruitment/internal-jobs/:id/apply — postulation interne par l'employé
  fastify.post('/internal-jobs/:id/apply', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      const body = request.body as { cover_letter?: string; phone?: string }
      try {
        const empRes = await pool.query<{
          id: string; first_name: string; last_name: string
          email: string | null; phone: string | null
        }>(
          `SELECT id, first_name, last_name, email, phone
             FROM "${schema}".employees
             WHERE user_id = $1 OR email = $2
             LIMIT 1`,
          [request.user.sub, request.user.email],
        )
        const emp = empRes.rows[0]
        if (!emp) return reply.status(403).send({ error: 'Profil employé introuvable' })

        // Empêcher les doublons
        const dup = await pool.query(
          `SELECT id FROM "${schema}".applications
            WHERE job_id = $1 AND internal_employee_id = $2`,
          [id, emp.id],
        )
        if (dup.rows[0]) {
          return reply.status(409).send({ error: 'Vous avez déjà postulé à cette offre' })
        }

        const res = await pool.query(`
          INSERT INTO "${schema}".applications
            (job_id, first_name, last_name, email, phone, cover_letter,
             stage, source, internal_employee_id)
          VALUES ($1,$2,$3,$4,$5,$6,'new','internal',$7)
          RETURNING *
        `, [
          id, emp.first_name, emp.last_name,
          emp.email ?? request.user.email,
          body.phone ?? emp.phone,
          body.cover_letter ?? null,
          emp.id,
        ])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── CANDIDATURES ───────────────────────────────────────────────────────────
  fastify.get('/applications', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { job_id, stage } = request.query as Record<string, string>
      let sql = `SELECT a.*, rj.title AS job_title
                 FROM "${schema}".applications a
                 JOIN "${schema}".recruitment_jobs rj ON rj.id = a.job_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (job_id) { sql += ` AND a.job_id = $${idx++}`; params.push(job_id) }
      if (stage)  { sql += ` AND a.stage = $${idx++}`; params.push(stage) }
      sql += ` ORDER BY a.created_at DESC`
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  fastify.post('/applications', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const body = request.body as Record<string, unknown>
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".applications
            (job_id, first_name, last_name, email, phone, cover_letter,
             cv_text, stage, source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'new',$8)
          RETURNING *
        `, [
          body.job_id, body.first_name, body.last_name, body.email,
          body.phone || null, body.cover_letter || null,
          body.cv_text || null,
          body.source || 'manual',
        ])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  fastify.patch('/applications/:id/stage', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      const { stage, notes } = request.body as { stage: string; notes?: string }
      if (!STAGES.includes(stage)) return reply.status(400).send({ error: 'Stage invalide' })
      try {
        const res = await pool.query(`
          UPDATE "${schema}".applications
          SET stage = $1, notes = COALESCE($2, notes), updated_at = now()
          WHERE id = $3 RETURNING *
        `, [stage, notes || null, id])
        const app = res.rows[0]

        // Feedback loop IA : on snapshot la décision pour alimenter le few-shot des
        // prochaines pré-sélections de ce tenant. Uniquement sur hired/rejected
        // (signaux forts). Non bloquant si la table n'existe pas encore.
        // OWASP A03 : on neutralise les sauts de ligne et caractères de contrôle
        // dans ai_summary pour limiter les vecteurs de prompt injection (le texte
        // sera réinjecté dans le prompt de la prochaine pré-sélection).
        if (app && (stage === 'hired' || stage === 'rejected')) {
          const summaryClean = (app.ai_summary ?? '')
            .toString()
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim()
            .slice(0, 200)
          const anchorParts = [
            `${app.first_name ?? ''} ${app.last_name ?? ''}`.trim(),
            summaryClean,
          ].filter(Boolean)
          pool.query(
            `INSERT INTO "${schema}".recruitment_decisions
               (job_id, application_id, decision, decided_by,
                prior_ai_score, prior_ai_recommendation, candidate_anchor)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              app.job_id, app.id, stage, request.user.sub,
              app.ai_score ?? null,
              app.ai_recommendation ?? null,
              anchorParts.join(' — ') || null,
            ],
          ).catch(() => { /* table absente : migration lazy au prochain preselect */ })

          // OWASP A09 : trace explicite de la décision (qui, sur qui, quand,
          // avec quel score IA prior). Hire/reject est un événement de sécurité
          // significatif au sens RGPD (décision impactant un candidat).
          pool.query(
            `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
             VALUES ($1, $2, 'application', $3, $4, $5)`,
            [
              request.user.sub,
              stage === 'hired' ? 'recruitment.hired' : 'recruitment.rejected',
              app.id,
              JSON.stringify({
                jobId: app.job_id,
                priorAiScore: app.ai_score ?? null,
                priorAiRecommendation: app.ai_recommendation ?? null,
              }),
              request.ip ?? null,
            ],
          ).catch(() => { /* tenant sans audit_log : non bloquant */ })
        }

        return reply.send({ data: app })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── UPLOAD CV (multipart) ──────────────────────────────────────────────────
  // OWASP A03 (content type spoofing) : allowlist stricte sur le MIME du fichier
  // et taille max 10 MB. Stocke à la fois le binaire (cv_blob pour viewer UI)
  // et le texte extrait (cv_text pour analyse IA — extraction PDF native dans
  // un sprint suivant).
  const CV_ALLOWED_MIMES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
  ])
  const CV_MAX_BYTES = 10 * 1024 * 1024
  fastify.post('/applications/:id/upload-cv', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      try {
        const file = await request.file()
        if (!file) return reply.status(400).send({ error: 'Aucun fichier reçu' })

        // OWASP A03 (content type spoofing) : allowlist stricte du MIME
        const mimetype = (file.mimetype || '').toLowerCase()
        if (!CV_ALLOWED_MIMES.has(mimetype)) {
          return reply.status(400).send({
            error: 'Format de fichier non autorisé. Accepté : PDF, DOC, DOCX, TXT.',
          })
        }

        const buf = await file.toBuffer()
        if (buf.byteLength > CV_MAX_BYTES) {
          return reply.status(400).send({
            error: `Fichier trop volumineux (max ${CV_MAX_BYTES / (1024 * 1024)} MB).`,
          })
        }
        // Extraction texte : PDF natif via unpdf, sinon UTF-8 (TXT direct,
        // DOC/DOCX partiel — extraction native dans un sprint suivant).
        const cvText = await extractCvText(buf, mimetype)
        const filename = file.filename || 'cv.bin'
        const cvUrl = `local://${filename}`
        const res = await pool.query(`
          UPDATE "${schema}".applications
          SET cv_url = $1,
              cv_text = $2,
              cv_blob = $3,
              cv_mime_type = $4,
              cv_filename = $5,
              cv_size_bytes = $6,
              updated_at = now()
          WHERE id = $7 RETURNING id, cv_url, cv_filename, cv_mime_type, cv_size_bytes
        `, [cvUrl, cvText, buf, mimetype, filename, buf.byteLength, id])
        if (!res.rows[0]) return reply.status(404).send({ error: 'Candidature introuvable' })
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur upload CV' })
      }
    },
  })

  // ── DOWNLOAD CV BLOB (pour viewer UI) ──────────────────────────────────────
  // Streame le binaire du CV stocké en cv_blob avec le bon Content-Type pour
  // que le navigateur affiche le PDF inline ou propose un téléchargement.
  // OWASP A05 : X-Content-Type-Options: nosniff pour bloquer le MIME sniffing.
  fastify.get('/applications/:id/cv-file', {
    // OWASP A01 — le CV (PII candidat) n'est accessible qu'aux rôles qui recrutent
    // activement. 'readonly' (consultation passive) retiré : il ne doit pas tirer
    // les binaires CV.
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return reply.status(400).send({ error: 'application id invalide (UUID requis)' })
      }
      try {
        const res = await pool.query<{
          cv_blob: Buffer | null
          cv_mime_type: string | null
          cv_filename: string | null
        }>(
          `SELECT cv_blob, cv_mime_type, cv_filename
             FROM "${schema}".applications WHERE id = $1`,
          [id],
        )
        const row = res.rows[0]
        if (!row || !row.cv_blob) {
          return reply.status(404).send({ error: 'Aucun CV binaire stocké pour cette candidature' })
        }
        const mime = row.cv_mime_type ?? 'application/octet-stream'
        const filename = row.cv_filename ?? 'cv.bin'
        const safeName = filename.replace(/[^\w.\-]/g, '_')
        reply
          .header('Content-Type', mime)
          .header('Content-Disposition', `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cache-Control', 'private, max-age=60')
        return reply.send(row.cv_blob)
      } catch (err) {
        fastify.log.error({ err }, 'cv-file fetch failed')
        return reply.status(500).send({ error: 'Erreur récupération CV' })
      }
    },
  })

  // ── ANALYSE IA d'un CV (choix du modèle dans la requête) ───────────────────
  // Rate limit dédié : l'appel IA est coûteux (~$0.01-0.05 par analyse).
  // 10 req/min/IP empêche les abus de quota et la facture surprise.
  fastify.post('/applications/:id/analyze-cv', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      const { model: rawModel, cv_text: overrideCv } =
        (request.body ?? {}) as { model?: string; cv_text?: string }
      const model: AiModelChoice = rawModel === 'mistral' ? 'mistral' : 'claude'

      try {
        const appRes = await pool.query<{
          id: string; job_id: string
          cv_text: string | null; cover_letter: string | null
          cv_blob: Buffer | null; cv_mime_type: string | null
        }>(
          `SELECT id, job_id, cv_text, cover_letter, cv_blob, cv_mime_type
             FROM "${schema}".applications WHERE id = $1`,
          [id],
        )
        const app = appRes.rows[0]
        if (!app) return reply.status(404).send({ error: 'Candidature introuvable' })

        const cvText = overrideCv ?? app.cv_text ?? app.cover_letter ?? ''
        if (!cvText || cvText.trim().length < 50) {
          return reply.status(400).send({
            error: 'CV trop court ou manquant. Téléversez un CV avant l\'analyse.',
          })
        }

        const jobRes = await pool.query<JobContext>(
          `SELECT title, description, requirements, contract_type, location,
                  salary_min::float AS "salaryMin", salary_max::float AS "salaryMax",
                  contract_type AS "contractType"
             FROM "${schema}".recruitment_jobs WHERE id = $1`,
          [app.job_id],
        )
        const job = jobRes.rows[0]
        if (!job) return reply.status(404).send({ error: 'Offre liée introuvable' })

        // Fallback Claude Vision : si le PDF est stocké, on le passe à analyzeCV
        // qui décidera (selon la qualité du texte extrait) s'il bascule sur le
        // mode document natif.
        const pdfFallback = app.cv_mime_type === 'application/pdf' ? app.cv_blob : null
        const result = await analyzeCV(model, job, cvText, undefined, pdfFallback)

        const upd = await pool.query(`
          UPDATE "${schema}".applications
          SET ai_score = $1,
              ai_summary = $2,
              ai_recommendation = $3,
              ai_match_percentage = $4,
              ai_strengths = $5,
              ai_gaps = $6,
              ai_red_flags = $7,
              ai_interview_questions = $8,
              ai_model_used = $9,
              ai_signals_used = $10,
              ai_demographic_risk_note = $11,
              ai_analyzed_at = now(),
              updated_at = now()
          WHERE id = $12 RETURNING *
        `, [
          result.score, result.summary, result.recommendation,
          result.matchPercentage,
          JSON.stringify(result.strengths),
          JSON.stringify(result.gaps),
          JSON.stringify(result.redFlags),
          JSON.stringify(result.interviewQuestions),
          result.modelUsed,
          JSON.stringify(result.signalsUsed ?? []),
          result.demographicRiskNote ?? null,
          id,
        ])

        // OWASP A09 : trace de l'usage IA (qui, sur qui, avec quel modèle,
        // quel score). Non-bloquant si audit_log absent.
        pool.query(
          `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
           VALUES ($1, 'recruitment.analyze_cv', 'application', $2, $3, $4)`,
          [request.user.sub, id,
           JSON.stringify({ model: result.modelUsed, score: result.score, recommendation: result.recommendation }),
           request.ip ?? null],
        ).catch(() => { /* tenant sans audit_log : non bloquant */ })

        return reply.send({ data: upd.rows[0], analysis: result })
      } catch (err) {
        // OWASP A10 : ne pas exposer les détails internes au client.
        // On loge le message complet côté serveur, on retourne un message
        // générique safe — sauf cas explicitement utiles à l'utilisateur
        // (clé manquante / CV trop court / modèle non configuré).
        const raw = err instanceof Error ? err.message : ''
        fastify.log.error({ err }, 'analyze-cv failed')
        const isUserActionable = /CV trop court|configurée|inconnu|stub/i.test(raw)
        return reply.status(500).send({
          error: isUserActionable ? raw : 'Erreur lors de l\'analyse IA. Réessayez plus tard.',
        })
      }
    },
  })

  // ── PRÉ-SÉLECTION EN LOT (batch) ───────────────────────────────────────────
  // Analyse en série toutes les candidatures non encore traitées d'une offre
  // (par défaut stage='new'). Coût IA borné par maxCandidates (≤ 50/appel) et
  // par le rate-limit (3 req/min). Audit log par lot, pas par CV individuel.
  // Optionnel : `criteria.focus` injecté dans les requirements de l'offre pour
  // orienter le scoring IA selon les priorités du recruteur.
  fastify.post('/jobs/:id/preselect', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id: jobId } = request.params as { id: string }
      const body = (request.body ?? {}) as {
        model?: string
        stages?: string[]
        force?: boolean
        maxCandidates?: number
        criteria?: { focus?: string }
      }

      const model: AiModelChoice = body.model === 'mistral' ? 'mistral' : 'claude'
      const requestedStages = Array.isArray(body.stages) && body.stages.length > 0
        ? body.stages : ['new']
      const invalidStage = requestedStages.find((s) => !STAGES.includes(s))
      if (invalidStage) {
        return reply.status(400).send({ error: `Stage invalide : ${invalidStage}` })
      }
      const force = body.force === true
      const maxCandidatesRaw = typeof body.maxCandidates === 'number' ? body.maxCandidates : 20
      const maxCandidates = Math.min(Math.max(Math.floor(maxCandidatesRaw), 1), 50)
      const criteriaFocus = body.criteria?.focus?.trim() || null

      try {
        const jobRes = await pool.query<JobContext & { ai_focus_text: string | null }>(
          `SELECT title, description, requirements, contract_type, location,
                  salary_min::float AS "salaryMin", salary_max::float AS "salaryMax",
                  contract_type AS "contractType",
                  ai_focus_text
             FROM "${schema}".recruitment_jobs WHERE id = $1`,
          [jobId],
        )
        const job = jobRes.rows[0]
        if (!job) return reply.status(404).send({ error: 'Offre introuvable' })

        // Critère effectif : si body.criteria.focus fourni → écrit ai_focus_text
        // dans le job (persistance). Sinon, fallback sur la valeur stockée.
        const effectiveFocus = criteriaFocus ?? job.ai_focus_text?.trim() ?? null
        if (criteriaFocus !== null && criteriaFocus !== job.ai_focus_text) {
          await pool.query(
            `UPDATE "${schema}".recruitment_jobs
                SET ai_focus_text = $1, updated_at = now()
              WHERE id = $2`,
            [criteriaFocus, jobId],
          )
        }

        const appsRes = await pool.query<{
          id: string
          cv_text: string | null
          cover_letter: string | null
          cv_blob: Buffer | null
          cv_mime_type: string | null
          first_name: string
          last_name: string
        }>(
          `SELECT id, cv_text, cover_letter, cv_blob, cv_mime_type, first_name, last_name
             FROM "${schema}".applications
            WHERE job_id = $1
              AND stage = ANY($2::text[])
              ${force ? '' : 'AND ai_analyzed_at IS NULL'}
            ORDER BY created_at ASC
            LIMIT $3`,
          [jobId, requestedStages, maxCandidates],
        )
        const candidates = appsRes.rows

        if (candidates.length === 0) {
          return reply.send({
            total: 0,
            analyzed: 0,
            skipped: 0,
            failed: 0,
            top: [],
            model,
            message: 'Aucune candidature à analyser pour ces stages.',
          })
        }

        const enrichedJob: JobContext = effectiveFocus
          ? {
              ...job,
              requirements: [job.requirements?.trim(), `Priorité du recruteur : ${effectiveFocus}`]
                .filter(Boolean).join('\n\n'),
            }
          : job

        // Feedback loop : on injecte les 8 dernières décisions du tenant pour
        // calibrer le scoring IA sur ses préférences réelles. Non bloquant si
        // la table n'existe pas encore (tenants pré-migration).
        const decisionExamples: RecruiterDecisionExample[] = await pool.query<{
          decision: string
          prior_ai_score: number | null
          candidate_anchor: string | null
        }>(
          `SELECT decision, prior_ai_score, candidate_anchor
             FROM "${schema}".recruitment_decisions
            WHERE candidate_anchor IS NOT NULL
            ORDER BY decided_at DESC
            LIMIT 8`,
        ).then((r) => r.rows
          .filter((row) => row.decision === 'hired' || row.decision === 'rejected')
          .map((row) => ({
            decision: row.decision as 'hired' | 'rejected',
            priorAiScore: row.prior_ai_score,
            anchor: row.candidate_anchor!,
          }))
        ).catch(() => [])

        let analyzed = 0
        let skipped = 0
        let failed = 0
        const results: Array<{
          id: string
          score: number
          recommendation: string
          firstName: string
          lastName: string
        }> = []

        for (const c of candidates) {
          const cvText = c.cv_text ?? c.cover_letter ?? ''
          if (!cvText || cvText.trim().length < 50) {
            skipped++
            continue
          }
          try {
            const pdfFallback = c.cv_mime_type === 'application/pdf' ? c.cv_blob : null
            const result = await analyzeCV(model, enrichedJob, cvText, decisionExamples, pdfFallback)
            await pool.query(`
              UPDATE "${schema}".applications
              SET ai_score = $1,
                  ai_summary = $2,
                  ai_recommendation = $3,
                  ai_match_percentage = $4,
                  ai_strengths = $5,
                  ai_gaps = $6,
                  ai_red_flags = $7,
                  ai_interview_questions = $8,
                  ai_model_used = $9,
                  ai_signals_used = $10,
                  ai_demographic_risk_note = $11,
                  ai_analyzed_at = now(),
                  updated_at = now()
              WHERE id = $12
            `, [
              result.score, result.summary, result.recommendation,
              result.matchPercentage,
              JSON.stringify(result.strengths),
              JSON.stringify(result.gaps),
              JSON.stringify(result.redFlags),
              JSON.stringify(result.interviewQuestions),
              result.modelUsed,
              JSON.stringify(result.signalsUsed ?? []),
              result.demographicRiskNote ?? null,
              c.id,
            ])
            analyzed++
            results.push({
              id: c.id,
              score: result.score,
              recommendation: result.recommendation,
              firstName: c.first_name,
              lastName: c.last_name,
            })
          } catch (err) {
            fastify.log.error({ err, candidateId: c.id }, 'preselect: analyze failed for candidate')
            failed++
          }
        }

        pool.query(
          `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
           VALUES ($1, 'recruitment.preselect_batch', 'recruitment_job', $2, $3, $4)`,
          [request.user.sub, jobId,
           JSON.stringify({
             model, stages: requestedStages, force,
             analyzed, skipped, failed,
             effectiveFocus,
             focusSource: criteriaFocus !== null ? 'request' : (job.ai_focus_text ? 'job-stored' : null),
             learningExamples: decisionExamples.length,
           }),
           request.ip ?? null],
        ).catch(() => { /* tenant sans audit_log : non bloquant */ })

        const top = results.sort((a, b) => b.score - a.score).slice(0, 10)

        return reply.send({
          total: candidates.length,
          analyzed,
          skipped,
          failed,
          top,
          model,
          effectiveFocus,
          learningExamples: decisionExamples.length,
        })
      } catch (err) {
        fastify.log.error({ err }, 'preselect-batch failed')
        return reply.status(500).send({
          error: 'Erreur lors de la pré-sélection en lot. Réessayez plus tard.',
        })
      }
    },
  })

  // ── HISTORIQUE D'APPRENTISSAGE IA (decisions-history) ──────────────────────
  // Lecture seule des décisions hire/reject qui alimentent le feedback loop
  // few-shot du tenant. Sert à expliquer pourquoi un score IA est ce qu'il est :
  // « voici les 23 décisions de votre équipe qui ont calibré le scoring ».
  // RBAC : ouvert à toutes les vues recrutement (admin/hr/manager/readonly).
  // Renvoie [] proprement si la table n'a pas encore été créée pour le tenant.
  fastify.get('/jobs/:id/decisions-history', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id: jobId } = request.params as { id: string }
      // OWASP A03 : valider que jobId est bien un UUID (évite l'injection même si bindé)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
        return reply.status(400).send({ error: 'jobId invalide (UUID requis)' })
      }
      const { limit: limitRaw } = request.query as { limit?: string }
      const limit = Math.min(Math.max(parseInt(limitRaw ?? '50', 10) || 50, 1), 100)

      try {
        const res = await pool.query<{
          id: string
          decision: 'hired' | 'rejected'
          decided_at: Date
          decided_by: string | null
          prior_ai_score: number | null
          prior_ai_recommendation: string | null
          candidate_anchor: string | null
        }>(
          `SELECT id, decision, decided_at, decided_by,
                  prior_ai_score, prior_ai_recommendation, candidate_anchor
             FROM "${schema}".recruitment_decisions
            WHERE job_id = $1
            ORDER BY decided_at DESC
            LIMIT $2`,
          [jobId, limit],
        )
        const counts = res.rows.reduce(
          (acc, r) => {
            if (r.decision === 'hired') acc.hired++
            else if (r.decision === 'rejected') acc.rejected++
            return acc
          },
          { hired: 0, rejected: 0 },
        )
        return reply.send({
          data: res.rows,
          counts,
          total: res.rows.length,
        })
      } catch (err) {
        // Table absente (tenant pré-migration) → renvoyer une liste vide, pas 500
        const msg = err instanceof Error ? err.message : ''
        if (/recruitment_decisions/i.test(msg) && /does not exist|n'existe pas/i.test(msg)) {
          return reply.send({ data: [], counts: { hired: 0, rejected: 0 }, total: 0 })
        }
        fastify.log.error({ err }, 'decisions-history failed')
        return reply.status(500).send({
          error: 'Erreur lors du chargement de l\'historique. Réessayez plus tard.',
        })
      }
    },
  })

  // ── PAGE CARRIÈRES PUBLIQUE (sans auth) ────────────────────────────────────
  // Liste des offres externes/both d'un tenant. Tenant résolu par slug.
  // Retourne aussi le branding (logo, couleurs, ville) pour thématiser la page.
  fastify.get('/public/:tenantSlug/jobs', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { tenantSlug } = request.params as { tenantSlug: string }
      const tenant = await pool.query<{
        schema_name: string; name: string; slug: string
        primary_color: string | null; secondary_color: string | null
        logo_url: string | null; city: string | null; sector: string | null
      }>(
        `SELECT schema_name, name, slug, primary_color, secondary_color,
                logo_url, city, sector
           FROM platform.tenants
          WHERE slug = $1 AND status IN ('active','trial')
          LIMIT 1`,
        [tenantSlug],
      )
      if (!tenant.rows[0]) return reply.status(404).send({ error: 'Entreprise introuvable' })
      const t = tenant.rows[0]
      await ensureRecruitmentSchemaMigrated(t.schema_name)
      const jobs = await pool.query(`
        SELECT id, title, location, contract_type, salary_min, salary_max,
               currency, description, requirements, public_slug,
               created_at, published_at,
               (SELECT count(*)::int FROM "${t.schema_name}".applications a
                  WHERE a.job_id = rj.id) AS applications_count
          FROM "${t.schema_name}".recruitment_jobs rj
          WHERE status = 'open' AND visibility IN ('external','both')
          ORDER BY published_at DESC NULLS LAST, created_at DESC
      `)
      return reply.send({
        tenant: {
          name: t.name, slug: t.slug, city: t.city, sector: t.sector,
          primaryColor: t.primary_color ?? '#E85D04',
          secondaryColor: t.secondary_color ?? '#F48C06',
          logoUrl: t.logo_url,
        },
        data: jobs.rows,
        count: jobs.rowCount ?? 0,
      })
    },
  })

  // GET /public/:tenantSlug/jobs/:jobId — détail offre (page dédiée)
  fastify.get('/public/:tenantSlug/jobs/:jobId', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { tenantSlug, jobId } = request.params as { tenantSlug: string; jobId: string }
      const tenant = await pool.query<{
        schema_name: string; name: string; slug: string
        primary_color: string | null; secondary_color: string | null
        logo_url: string | null; city: string | null
      }>(
        `SELECT schema_name, name, slug, primary_color, secondary_color,
                logo_url, city
           FROM platform.tenants
          WHERE slug = $1 AND status IN ('active','trial')
          LIMIT 1`,
        [tenantSlug],
      )
      if (!tenant.rows[0]) return reply.status(404).send({ error: 'Entreprise introuvable' })
      const t = tenant.rows[0]
      await ensureRecruitmentSchemaMigrated(t.schema_name)
      const job = await pool.query(`
        SELECT id, title, location, contract_type, salary_min, salary_max,
               currency, description, requirements,
               created_at, published_at
          FROM "${t.schema_name}".recruitment_jobs
          WHERE id = $1 AND status = 'open' AND visibility IN ('external','both')
          LIMIT 1
      `, [jobId])
      if (!job.rows[0]) return reply.status(404).send({ error: 'Offre introuvable ou fermée' })
      return reply.send({
        tenant: {
          name: t.name, slug: t.slug, city: t.city,
          primaryColor: t.primary_color ?? '#E85D04',
          secondaryColor: t.secondary_color ?? '#F48C06',
          logoUrl: t.logo_url,
        },
        data: job.rows[0],
      })
    },
  })

  // POST candidature publique — OWASP A05 : rate-limit anti-spam (5/IP/h)
  fastify.post('/public/:tenantSlug/jobs/:jobId/apply', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    handler: async (request, reply) => {
      const { tenantSlug, jobId } = request.params as { tenantSlug: string; jobId: string }
      // Zod validation stricte (OWASP A03 Injection + A04 Insecure Design)
      const parsed = publicApplySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data

      const tenant = await pool.query<{ schema_name: string; name: string }>(
        `SELECT schema_name, name FROM platform.tenants
          WHERE slug = $1 AND status IN ('active','trial') LIMIT 1`,
        [tenantSlug],
      )
      if (!tenant.rows[0]) return reply.status(404).send({ error: 'Entreprise introuvable' })
      const schema = tenant.rows[0].schema_name
      await ensureRecruitmentSchemaMigrated(schema)

      const job = await pool.query(
        `SELECT id, title FROM "${schema}".recruitment_jobs
          WHERE id = $1 AND status = 'open' AND visibility IN ('external','both')`,
        [jobId],
      )
      if (!job.rows[0]) return reply.status(404).send({ error: 'Offre introuvable ou fermée' })

      // Anti-doublon : si même email a déjà postulé à cette offre, refuser
      const dup = await pool.query(
        `SELECT id FROM "${schema}".applications
          WHERE job_id = $1 AND lower(email) = lower($2) LIMIT 1`,
        [jobId, body.email],
      )
      if (dup.rows[0]) {
        return reply.status(409).send({
          error: 'Vous avez déjà postulé à cette offre',
          applicationId: dup.rows[0].id,
        })
      }

      const res = await pool.query<{ id: string }>(`
        INSERT INTO "${schema}".applications
          (job_id, first_name, last_name, email, phone, cover_letter, cv_text,
           stage, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'new','careers_page')
        RETURNING id
      `, [
        jobId, body.first_name, body.last_name, body.email,
        body.phone ?? null, body.cover_letter ?? null, body.cv_text ?? null,
      ])

      // Audit log non-bloquant (OWASP A09)
      pool.query(
        `INSERT INTO "${schema}".audit_log (action, entity, entity_id, changes, ip_address)
         VALUES ('public.application_submitted', 'application', $1, $2, $3)`,
        [res.rows[0]!.id,
         JSON.stringify({ jobId, jobTitle: job.rows[0].title, source: 'careers_page' }),
         request.ip ?? null],
      ).catch(() => { /* table absente → ignore */ })

      return reply.status(201).send({
        data: { id: res.rows[0]!.id, jobTitle: job.rows[0].title, companyName: tenant.rows[0].name },
        message: 'Candidature envoyée — vous serez recontacté(e) si votre profil correspond.',
      })
    },
  })

  // ── SOURCING IA — génération de profils synthétiques pour une offre ────────
  // Génère N profils candidats réalistes + stratégie de sourcing pour le poste.
  // Calibré multi-pays africains (filiales / groupes panafricains). Rate-limité
  // car l'appel IA est coûteux (~$0.05–0.20 selon le nombre de profils).
  fastify.post('/jobs/:id/source', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as {
        model?:        string
        platforms?:    string[]
        countries?:    string[]
        max_profiles?: number
      }
      const model: AiModelChoice = body.model === 'mistral' ? 'mistral' : 'claude'
      const platforms = Array.isArray(body.platforms) && body.platforms.length
        ? body.platforms
        : ['LinkedIn', 'Africawork', 'Emploi.ci', 'Jobberman']
      const countries = Array.isArray(body.countries) && body.countries.length
        ? body.countries
        : ['CI']
      const maxProfiles = Math.max(1, Math.min(Number(body.max_profiles) || 10, 20))

      try {
        const jobRes = await pool.query<SourcingContext>(
          `SELECT title, description, requirements, contract_type AS "contractType",
                  location,
                  salary_min::float AS "salaryMin", salary_max::float AS "salaryMax",
                  currency
             FROM "${schema}".recruitment_jobs WHERE id = $1`,
          [id],
        )
        const job = jobRes.rows[0]
        if (!job) return reply.status(404).send({ error: 'Offre introuvable' })

        const result = await sourceProfiles(model, job, platforms, maxProfiles, countries)

        // OWASP A09 : trace de l'usage IA (qui, sur quelle offre, modèle, profils)
        pool.query(
          `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
           VALUES ($1, 'recruitment.source_profiles', 'recruitment_job', $2, $3, $4)`,
          [request.user.sub, id,
           JSON.stringify({
             model:    result.model,
             provider: result.provider,
             profiles: result.profilesGenerated,
             cost:     result.estimatedCostEur,
             countries,
             platforms,
           }),
           request.ip ?? null],
        ).catch(() => { /* tenant sans audit_log : non bloquant */ })

        return reply.send({
          data: result.data,
          meta: {
            provider:         result.provider,
            model:            result.model,
            latencyMs:        result.latencyMs,
            inputTokens:      result.inputTokens,
            outputTokens:     result.outputTokens,
            estimatedCostEur: result.estimatedCostEur,
            richnessScore:    result.richnessScore,
            jsonValid:        result.jsonValid,
          },
          jobId: id,
        })
      } catch (err) {
        const raw = err instanceof Error ? err.message : ''
        fastify.log.error({ err }, 'recruitment.source failed')
        const isUserActionable = /configurée|configuré|introuvable/i.test(raw)
        return reply.status(500).send({
          error: isUserActionable ? raw : 'Erreur lors du sourcing IA. Réessayez plus tard.',
        })
      }
    },
  })

  // ── SOURCING IA — liste des profils en cache (pour visualisation) ──────────
  // Retourne tous les profils sourced stockés pour cette offre, transférés ou non.
  // Permet d'avoir un visuel immédiat sans devoir relancer l'IA.
  fastify.get('/jobs/:id/sourced-profiles', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      try {
        const res = await pool.query(
          `SELECT id, job_id, first_name, last_name, current_position, current_company,
                  location, experience_years, key_skills, match_score,
                  availability_estimate, suggested_platform, linkedin_search,
                  approach_strategy, estimated_salary, estimated_salary_currency,
                  email, phone, source_provider, source_model, countries,
                  transferred_to_application_id, transferred_at, created_at
             FROM "${schema}".sourced_profiles
            WHERE job_id = $1
            ORDER BY match_score DESC NULLS LAST, created_at DESC`,
          [id],
        )
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── SOURCING IA — transfert d'un profil vers le pipeline (Kanban) ──────────
  // Crée une candidature (applications) avec source='sourced_ai' stage='new'
  // et marque le profil sourced comme transféré. Idempotent : si déjà transféré,
  // retourne 409 avec le pointeur vers l'application existante.
  fastify.post('/jobs/:id/sourced-profiles/:profileId/transfer', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id, profileId } = request.params as { id: string; profileId: string }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const sp = await client.query<{
          id: string; job_id: string; first_name: string; last_name: string
          email: string | null; phone: string | null
          match_score: number | null; current_position: string | null
          current_company: string | null; key_skills: unknown
          transferred_to_application_id: string | null
        }>(
          `SELECT id, job_id, first_name, last_name, email, phone, match_score,
                  current_position, current_company, key_skills,
                  transferred_to_application_id
             FROM "${schema}".sourced_profiles
            WHERE id = $1 AND job_id = $2
            FOR UPDATE`,
          [profileId, id],
        )
        const profile = sp.rows[0]
        if (!profile) {
          await client.query('ROLLBACK')
          return reply.status(404).send({ error: 'Profil introuvable pour cette offre' })
        }
        if (profile.transferred_to_application_id) {
          await client.query('ROLLBACK')
          return reply.status(409).send({
            error: 'Profil déjà transféré',
            applicationId: profile.transferred_to_application_id,
          })
        }

        // Email synthétique si absent (pour respecter applications.email NOT NULL)
        const email = profile.email ??
          `${profile.first_name}.${profile.last_name}.sourced@example.com`
            .toLowerCase().replace(/[^a-z0-9.@]/g, '')

        const summary = `Profil sourcé par IA · ${profile.current_position ?? 'poste actuel inconnu'}` +
          (profile.current_company ? ` chez ${profile.current_company}` : '')

        const appRes = await client.query<{ id: string }>(
          `INSERT INTO "${schema}".applications
             (job_id, first_name, last_name, email, phone, stage, source,
              ai_score, ai_recommendation, ai_match_percentage, ai_summary,
              ai_strengths, ai_model_used, ai_analyzed_at)
           VALUES ($1, $2, $3, $4, $5, 'new', 'sourced_ai',
                   $6, $7, $6, $8,
                   $9, 'sourced', now())
           RETURNING id`,
          [
            profile.job_id, profile.first_name, profile.last_name, email, profile.phone,
            profile.match_score, scoreToRecommendation(profile.match_score), summary,
            JSON.stringify(Array.isArray(profile.key_skills) ? profile.key_skills : []),
          ],
        )
        const applicationId = appRes.rows[0]!.id

        await client.query(
          `UPDATE "${schema}".sourced_profiles
              SET transferred_to_application_id = $1,
                  transferred_at = now(),
                  transferred_by = $2
            WHERE id = $3`,
          [applicationId, request.user.sub, profileId],
        )

        await client.query('COMMIT')

        // Audit log (non bloquant)
        pool.query(
          `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
           VALUES ($1, 'recruitment.sourced_transfer', 'application', $2, $3, $4)`,
          [request.user.sub, applicationId,
           JSON.stringify({ profileId, jobId: id, match: profile.match_score }),
           request.ip ?? null],
        ).catch(() => { /* tenant sans audit_log : non bloquant */ })

        return reply.status(201).send({ data: { applicationId, profileId } })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        fastify.log.error({ err }, 'recruitment.sourced.transfer failed')
        return reply.status(500).send({ error: 'Erreur lors du transfert' })
      } finally {
        client.release()
      }
    },
  })

  // ── SOURCING IA — transfert en masse des profils non encore transférés ────
  fastify.post('/jobs/:id/sourced-profiles/transfer-all', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const pending = await client.query<{
          id: string; first_name: string; last_name: string
          email: string | null; phone: string | null; match_score: number | null
          current_position: string | null; current_company: string | null
          key_skills: unknown
        }>(
          `SELECT id, first_name, last_name, email, phone, match_score,
                  current_position, current_company, key_skills
             FROM "${schema}".sourced_profiles
            WHERE job_id = $1 AND transferred_to_application_id IS NULL
            ORDER BY match_score DESC NULLS LAST
            FOR UPDATE`,
          [id],
        )

        const transferred: Array<{ profileId: string; applicationId: string }> = []
        for (const profile of pending.rows) {
          const email = profile.email ??
            `${profile.first_name}.${profile.last_name}.sourced@example.com`
              .toLowerCase().replace(/[^a-z0-9.@]/g, '')
          const summary = `Profil sourcé par IA · ${profile.current_position ?? 'poste actuel inconnu'}` +
            (profile.current_company ? ` chez ${profile.current_company}` : '')

          const appRes = await client.query<{ id: string }>(
            `INSERT INTO "${schema}".applications
               (job_id, first_name, last_name, email, phone, stage, source,
                ai_score, ai_recommendation, ai_match_percentage, ai_summary,
                ai_strengths, ai_model_used, ai_analyzed_at)
             VALUES ($1, $2, $3, $4, $5, 'new', 'sourced_ai',
                     $6, $7, $6, $8,
                     $9, 'sourced', now())
             RETURNING id`,
            [
              id, profile.first_name, profile.last_name, email, profile.phone,
              profile.match_score, scoreToRecommendation(profile.match_score), summary,
              JSON.stringify(Array.isArray(profile.key_skills) ? profile.key_skills : []),
            ],
          )
          const applicationId = appRes.rows[0]!.id

          await client.query(
            `UPDATE "${schema}".sourced_profiles
                SET transferred_to_application_id = $1,
                    transferred_at = now(),
                    transferred_by = $2
              WHERE id = $3`,
            [applicationId, request.user.sub, profile.id],
          )

          transferred.push({ profileId: profile.id, applicationId })
        }

        await client.query('COMMIT')

        pool.query(
          `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
           VALUES ($1, 'recruitment.sourced_transfer_all', 'recruitment_job', $2, $3, $4)`,
          [request.user.sub, id,
           JSON.stringify({ count: transferred.length }),
           request.ip ?? null],
        ).catch(() => { /* non bloquant */ })

        return reply.send({
          data: { transferred: transferred.length, items: transferred },
        })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        fastify.log.error({ err }, 'recruitment.sourced.transfer_all failed')
        return reply.status(500).send({ error: 'Erreur lors du transfert en masse' })
      } finally {
        client.release()
      }
    },
  })

  // ── SOURCING IA — comparaison Claude vs Mistral (appels parallèles) ─────────
  // Lance les deux modèles en parallèle et retourne un rapport comparatif avec
  // métriques (latence, tokens, coût, richesse). Limité à 10 profils max.
  fastify.post('/jobs/:id/source/compare', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as {
        platforms?:    string[]
        countries?:    string[]
        max_profiles?: number
      }
      const platforms = Array.isArray(body.platforms) && body.platforms.length
        ? body.platforms
        : ['LinkedIn', 'Africawork', 'Emploi.ci', 'Jobberman']
      const countries = Array.isArray(body.countries) && body.countries.length
        ? body.countries
        : ['CI']
      const maxProfiles = Math.max(1, Math.min(Number(body.max_profiles) || 5, 10))

      try {
        if (!isModelAvailable('mistral')) {
          return reply.status(422).send({
            error: 'MISTRAL_API_KEY non configurée — comparaison impossible',
            hint:  'Ajoutez MISTRAL_API_KEY=... dans votre .env pour activer la comparaison.',
          })
        }

        const jobRes = await pool.query<SourcingContext>(
          `SELECT title, description, requirements, contract_type AS "contractType",
                  location,
                  salary_min::float AS "salaryMin", salary_max::float AS "salaryMax",
                  currency
             FROM "${schema}".recruitment_jobs WHERE id = $1`,
          [id],
        )
        const job = jobRes.rows[0]
        if (!job) return reply.status(404).send({ error: 'Offre introuvable' })

        const result = await sourceProfilesCompare(job, platforms, maxProfiles, countries)

        pool.query(
          `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
           VALUES ($1, 'recruitment.source_compare', 'recruitment_job', $2, $3, $4)`,
          [request.user.sub, id,
           JSON.stringify({
             winner:         result.winner,
             claudeCost:     result.claude.estimatedCostEur,
             mistralCost:    result.mistral.estimatedCostEur,
             claudeRichness: result.claude.richnessScore,
             mistralRichness: result.mistral.richnessScore,
             countries,
             platforms,
           }),
           request.ip ?? null],
        ).catch(() => { /* tenant sans audit_log : non bloquant */ })

        return reply.send({
          comparison: {
            winner:         result.winner,
            ratios:         result.ratios,
            recommendation: result.recommendation,
            summary: {
              claude: {
                latencyMs:         result.claude.latencyMs,
                inputTokens:       result.claude.inputTokens,
                outputTokens:      result.claude.outputTokens,
                estimatedCostEur:  result.claude.estimatedCostEur,
                profilesGenerated: result.claude.profilesGenerated,
                jsonValid:         result.claude.jsonValid,
                richnessScore:     result.claude.richnessScore,
                error:             result.claude.error,
              },
              mistral: {
                latencyMs:         result.mistral.latencyMs,
                inputTokens:       result.mistral.inputTokens,
                outputTokens:      result.mistral.outputTokens,
                estimatedCostEur:  result.mistral.estimatedCostEur,
                profilesGenerated: result.mistral.profilesGenerated,
                jsonValid:         result.mistral.jsonValid,
                richnessScore:     result.mistral.richnessScore,
                error:             result.mistral.error,
              },
            },
          },
          results: {
            claude:  result.claude.data,
            mistral: result.mistral.data,
          },
          jobId:             id,
          requestedProfiles: maxProfiles,
        })
      } catch (err) {
        const raw = err instanceof Error ? err.message : ''
        fastify.log.error({ err }, 'recruitment.source.compare failed')
        const isUserActionable = /configurée|configuré|introuvable/i.test(raw)
        return reply.status(500).send({
          error: isUserActionable ? raw : 'Erreur lors de la comparaison IA. Réessayez plus tard.',
        })
      }
    },
  })
}

export default recruitmentRoutes
